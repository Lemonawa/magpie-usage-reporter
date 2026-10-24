import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Reporter, recordOf, normalizeOptions } from '../reporter.mjs';

const row = (id, more = {}) => ({ t: '2026-10-24T08:00:00Z', agent: 'codex', provider: 'codex', model: 'gpt-example', rid: `req-${id}`, in: 100, out: 20, cache_read: 50, reasoning: 5, status: 200, ...more });
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'magpie-reporter-'));
  await fs.mkdir(path.join(directory, 'usage-reporter'));
  await fs.writeFile(path.join(directory, 'usage-reporter/credentials.json'), JSON.stringify({ token: 'synthetic-test-key' }));
  await fs.writeFile(path.join(directory, 'providers.json'), JSON.stringify({ providers: [{ id: 'codex' }, { id: 'sg', preset: 'remote-magpie' }] }));
  await fs.writeFile(path.join(directory, 'usage.jsonl'), '');
  const seen = new Map(), bodies = [], auth = [];
  let fail = 0, loseAck = false, badAck = false;
  const server = http.createServer(async (req, res) => {
    let data = ''; for await (const chunk of req) data += chunk;
    bodies.push(data); auth.push(req.headers.authorization);
    if (fail) { fail--; res.writeHead(503); return res.end('{}'); }
    const records = JSON.parse(data).map((r, index) => {
      const status = seen.has(r.rid) ? 'skipped' : 'accepted'; seen.set(r.rid, r);
      return { index, rid: r.rid, status };
    });
    if (loseAck) { loseAck = false; req.socket.destroy(); return; }
    if (badAck) { res.end(JSON.stringify({ accepted: 0, skipped: records.length, records: [] })); return; }
    res.end(JSON.stringify({ accepted: records.filter(r => r.status === 'accepted').length, skipped: records.filter(r => r.status === 'skipped').length, records }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const options = { enabled: true, endpoint: `http://127.0.0.1:${server.address().port}`, includeProviders: ['codex', 'sg'], intervalMs: 250 };
  const reporters = [];
  const make = (more = {}) => { const r = new Reporter({ directory, options: { ...options, ...more } }); reporters.push(r); return r; };
  const append = async (...rows) => fs.appendFile(path.join(directory, 'usage.jsonl'), rows.map(r => JSON.stringify(r) + '\n').join(''));
  t.after(async () => { for (const r of reporters) await r.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, make, append, seen, bodies, auth, fail: () => { fail++; }, loseAck: () => { loseAck = true; }, badAck: () => { badAck = true; } };
}

test('strict allow-list, privacy, known zero vs unknown price, stable device-scoped IDs', () => {
  const source = row(1, { cost: 0, session: 'private-session', err: 'private-error', body: 'private-prompt', providerAccount: 'private-email' });
  const out = recordOf(source, 'device-a', new Set(['codex']), new Set());
  assert.equal(out.cost, 0); assert.equal(out.cache_read, 50); assert.equal(out.reasoning, 5);
  assert(!JSON.stringify(out).includes('private'));
  assert(!('cost' in recordOf(row(2), 'a', new Set(['codex']), new Set())));
  assert.notEqual(out.rid, recordOf(source, 'device-b', new Set(['codex']), new Set()).rid);
  for (const extra of [{ via: 'other' }, { computer: 'other' }, { source: 'reported' }, { handed_on: true }]) assert.equal(recordOf(row(1, extra), 'a', new Set(['codex']), new Set()), null);
  assert.equal(recordOf(row(1), 'a', new Set(['codex']), new Set(['codex'])), null);
  assert.throws(() => normalizeOptions({ endpoint: 'https://a.example/path' }));
});

test('backfills, appends, survives restart, and excludes remote/other-device records', async t => {
  const f = await fixture(t); await f.append(row(1), row(2, { provider: 'sg' }), row(3, { via: 'another' }));
  const a = f.make(); await a.start({ schedule: false }); await a.cycle(); assert.equal(f.seen.size, 1);
  assert.equal(f.auth[0], 'Bearer synthetic-test-key');
  await f.append(row(4)); await a.cycle(); assert.equal(f.seen.size, 2);
  await a.stop(); const b = f.make(); await b.start({ schedule: false }); await b.cycle(); assert.equal(f.bodies.length, 2);
  await f.append(row(5)); await b.cycle(); assert.equal(f.seen.size, 3);
});

test('offline retains durable outbox across restart; retries do not lose records', async t => {
  const f = await fixture(t); await f.append(row(1)); f.fail();
  const a = f.make(); await a.start({ schedule: false }); await a.cycle();
  assert.equal(a.state.pending.length, 1); assert.equal(f.seen.size, 0);
  await a.stop(); const b = f.make(); await b.start({ schedule: false }); await b.cycle();
  assert.equal(f.seen.size, 1); assert.equal(b.state.pending.length, 0);
});

test('server accepted but ACK lost: replay after restart is skipped, not double-counted', async t => {
  const f = await fixture(t); await f.append(row(1)); f.loseAck();
  const a = f.make(); await a.start({ schedule: false }); await a.cycle();
  assert.equal(f.seen.size, 1); assert.equal(a.state.pending.length, 1);
  await a.stop(); const b = f.make(); await b.start({ schedule: false }); await b.cycle();
  assert.equal(f.seen.size, 1); assert.equal(b.state.duplicates, 1);
});

test('partial writes and multibyte UTF-8 do not advance past incomplete line', async t => {
  const f = await fixture(t); const a = f.make(); await a.start({ schedule: false });
  const value = JSON.stringify(row(1, { model: '测试-model' })); const bytes = Buffer.from(value + '\n');
  const split = bytes.indexOf(Buffer.from('测试')) + 1;
  await fs.appendFile(path.join(f.directory, 'usage.jsonl'), bytes.subarray(0, split)); await a.cycle();
  assert.equal(f.seen.size, 0); assert.equal(a.state.offset, 0);
  await fs.appendFile(path.join(f.directory, 'usage.jsonl'), bytes.subarray(split)); await a.cycle();
  assert.equal(f.seen.size, 1); assert.equal([...f.seen.values()][0].model, '测试-model');
});

test('full replay and file rotation keep stable request IDs', async t => {
  const f = await fixture(t); await f.append(row(1)); const a = f.make(); await a.start({ schedule: false }); await a.cycle(); await a.stop();
  const b = f.make({ backfillGeneration: 'replay-1' }); await b.start({ schedule: false }); await b.cycle(); assert.equal(b.state.duplicates, 1);
  await fs.rename(path.join(f.directory, 'usage.jsonl'), path.join(f.directory, 'usage.old'));
  await f.append(row(1), row(2)); await b.cycle(); assert.equal(f.seen.size, 2); assert.equal(b.state.duplicates, 2);
});

test('one owner per config directory; disable stops timer and releases lock', async t => {
  const f = await fixture(t); const a = f.make(), b = f.make();
  assert.equal(await a.start({ schedule: false }), true); assert.equal(await b.start({ schedule: false }), false);
  a.stillEnabled = async () => false; await a.cycle(); assert.equal(a.active, false);
  assert.equal(await b.start({ schedule: false }), true);
});

test('corrupt progress fails closed; existing identity survives', async t => {
  const f = await fixture(t); const a = f.make(); await a.start({ schedule: false }); await a.stop();
  await fs.writeFile(path.join(f.directory, 'usage-reporter/state.json'), '{broken');
  await assert.rejects(f.make().start({ schedule: false }), /refusing to reset/);
});

test('invalid records quarantined without content; malformed ACK keeps outbox', async t => {
  const f = await fixture(t); await f.append(row(1, { in: -1, err: 'secret-text' }), row(2)); f.badAck();
  const a = f.make(); await a.start({ schedule: false }); await a.cycle();
  assert.equal(a.state.invalid, 1); assert.equal(a.state.pending.length, 1);
  assert(!(await fs.readFile(path.join(f.directory, 'usage-reporter/invalid.jsonl'), 'utf8')).includes('secret-text'));
});

test('tail-only mode skips existing data and unfinished tail, then ships new calls', async t => {
  const f = await fixture(t); await f.append(row(1));
  const fragment = JSON.stringify(row(2)); await fs.appendFile(path.join(f.directory, 'usage.jsonl'), fragment.slice(0, 20));
  const a = f.make({ backfill: false }); await a.start({ schedule: false }); await a.cycle();
  await fs.appendFile(path.join(f.directory, 'usage.jsonl'), fragment.slice(20) + '\n'); await f.append(row(3)); await a.cycle();
  assert.equal(f.seen.size, 1); assert.equal([...f.seen.values()][0].in, 100); assert.equal(a.state.invalid, 0);
});

test('a real timer delivers a new completed request within the polling window', async t => {
  const f = await fixture(t); const a = f.make(); await a.start();
  const started = Date.now(); await f.append(row(1));
  while (!f.seen.size && Date.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.seen.size, 1); assert(Date.now() - started < 3000);
});

test('bounded batches drain a 650-call backlog without loss', async t => {
  const f = await fixture(t); await f.append(...Array.from({ length: 650 }, (_, i) => row(i)));
  const a = f.make(); await a.start({ schedule: false });
  for (let i = 0; i < 4; i++) await a.cycle();
  assert.equal(f.seen.size, 650); assert.equal(a.state.pending.length, 0);
  assert.deepEqual(f.bodies.map(b => JSON.parse(b).length), [200, 200, 200, 50]);
});

test('missing provider classification pauses capture rather than forwarding unknown traffic', async t => {
  const f = await fixture(t); await f.append(row(1)); await fs.unlink(path.join(f.directory, 'providers.json'));
  const a = f.make(); await a.start({ schedule: false }); await a.cycle();
  assert.equal(a.state.offset, 0); assert.equal(f.bodies.length, 0);
  const status = JSON.parse(await fs.readFile(path.join(f.directory, 'usage-reporter/status.json'), 'utf8'));
  assert.match(status.error, /classify remote/);
});

test('invalid RFC3339 and cache counts cannot poison a delivery batch', () => {
  const make = extra => recordOf(row(1, extra), 'a', new Set(['codex']), new Set());
  assert.throws(() => make({ t: '10/24/2026' }));
  assert.throws(() => make({ cache_write: 2, cache_write_1h: 3 }));
  assert.throws(() => make({ ttft_ms: 11, ms: 10 }));
});

test('real steady-state polling latency after startup is below one second at 250 ms', async t => {
  const f = await fixture(t); const a = f.make(); await a.start();
  while (a.busy) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 35));
  const start = Date.now(); await f.append(row(1));
  while (!f.seen.size && Date.now() - start < 2000) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.seen.size, 1); assert(Date.now() - start < 1000);
  console.log(`steady-state delivery latency: ${Date.now() - start} ms`);
});

test('replacement host waits for retiring owner and then takes over automatically', async t => {
  const f = await fixture(t); const a = f.make(), b = f.make();
  await a.start({ schedule: false }); assert.equal(await b.start(), false);
  await a.stop(); await f.append(row(1));
  const start = Date.now();
  while (!f.seen.size && Date.now() - start < 2500) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.seen.size, 1); assert.equal(b.active, true);
});

test('two device installations report the same upstream ID independently to one receiver', async t => {
  const win = await fixture(t), mac = await fixture(t);
  await win.append(row(1)); await mac.append(row(1));
  const a = win.make(), b = mac.make({ endpoint: a.options.endpoint });
  await a.start({ schedule: false }); await b.start({ schedule: false });
  await Promise.all([a.cycle(), b.cycle()]);
  assert.equal(win.seen.size, 2); assert.notEqual(a.device, b.device);
  assert.equal(mac.seen.size, 0);
});
