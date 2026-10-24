import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = x => createHash('sha256').update(x).digest('hex');
const counters = ['in', 'out', 'cache_read', 'cache_write', 'cache_write_1h', 'reasoning', 'ms', 'ttft_ms', 'first_text_ms', 'flow_ms'];
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v);
export function normalizeOptions(v = {}) {
  const o = {
    enabled: v.enabled === true,
    endpoint: String(v.endpoint || '').replace(/\/+$/, ''),
    includeProviders: [...new Set(v.includeProviders || ['codex'])].sort(),
    intervalMs: v.intervalMs ?? 2000,
    backfill: v.backfill !== false,
    backfillGeneration: String(v.backfillGeneration || ''),
  };
  if (o.enabled || o.endpoint) {
    const u = new URL(o.endpoint);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) throw Error('endpoint must be an HTTP(S) origin');
  }
  if (!Array.isArray(v.includeProviders ?? []) || !o.includeProviders.length || !o.includeProviders.every(text)) throw Error('includeProviders must be a nonempty list of provider IDs');
  if (!Number.isInteger(o.intervalMs) || o.intervalMs < 250 || o.intervalMs > 60000) throw Error('intervalMs must be 250..60000');
  return o;
}

async function atomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const h = await fs.open(tmp, 'wx', 0o600);
  try { await h.writeFile(JSON.stringify(value)); await h.sync(); }
  finally { await h.close(); }
  try { await fs.rename(tmp, file); }
  finally { await fs.unlink(tmp).catch(() => {}); }
}
async function readJSON(file, missing) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return missing; throw Error(`Cannot read ${path.basename(file)}; refusing to reset progress`); }
}

export function recordOf(row, device, allowed, remote) {
  if (row.source === 'reported' || row.computer || row.via || row.handed_on || !allowed.has(row.provider) || remote.has(row.provider)) return null;
  if (!text(row.agent) || !text(row.provider) || !text(row.model) || !text(row.t)) throw Error('missing/invalid identity fields');
  const time = Date.parse(row.t);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.t) || !Number.isFinite(time) || time < Date.UTC(2000, 0) || time > Date.now() + 3600000) throw Error('invalid time');
  if (!Number.isInteger(row.status) || row.status < 100 || row.status > 599) throw Error('invalid HTTP status');
  const out = { t: row.t, agent: row.agent, provider: row.provider, model: row.model, status: row.status };
  for (const k of counters) {
    if (row[k] === undefined) continue;
    const max = k.endsWith('ms') ? (k === 'flow_ms' ? 108000001 : 86400000) : 100000000;
    if (!Number.isInteger(row[k]) || row[k] < 0 || row[k] > max) throw Error(`invalid ${k}`);
    out[k] = row[k];
  }
  out.in ??= 0; out.out ??= 0;
  if ((out.cache_write_1h || 0) > (out.cache_write || 0)) throw Error('cache_write_1h exceeds total');
  if (out.ttft_ms && out.ms !== undefined && out.ttft_ms > out.ms) throw Error('ttft after request end');
  if (out.first_text_ms && ((out.ms !== undefined && out.first_text_ms > out.ms) || out.first_text_ms < (out.ttft_ms || 0))) throw Error('invalid first text time');
  if (out.flow_ms && out.ms !== undefined && out.flow_ms > out.ms * 10 / 8 + 1) throw Error('invalid flow time');
  if (text(row.effort)) out.effort = row.effort;
  // Deliberately omit session/account/email/error text and all request contents.
  // A known cost, including a real zero, survives; absence remains unknown.
  if (row.cost != null) {
    if (!Number.isFinite(row.cost) || row.cost < 0 || row.cost > 10000) throw Error('invalid cost');
    out.cost = row.cost;
  }
  const identity = row.rid || row.response_id || row.route_id;
  const key = identity == null ? JSON.stringify(out) : JSON.stringify([identity, row.t, row.provider, row.model, row.status]);
  out.rid = `usage-reporter:${device}:${hash(key)}`;
  return out;
}

export class Reporter {
  constructor({ directory, options = {}, stillEnabled = async () => true, fetchImpl = globalThis.fetch }) {
    this.directory = directory;
    this.options = normalizeOptions(options);
    this.folder = path.join(directory, 'usage-reporter');
    this.stateFile = path.join(this.folder, 'state.json');
    this.lockDir = path.join(this.folder, 'run.lock');
    this.stillEnabled = stillEnabled;
    this.fetch = fetchImpl;
    this.active = false;
    this.failures = 0;
    this.nextTry = 0;
  }
  async acquire() {
    await fs.mkdir(this.folder, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await fs.mkdir(this.lockDir, { mode: 0o700 });
        await atomic(path.join(this.lockDir, 'owner.json'), { pid: process.pid });
        this.locked = true; return true;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        const stat = await fs.stat(this.lockDir);
        const owner = await readJSON(path.join(this.lockDir, 'owner.json'), null);
        if (!owner) { if (Date.now() - stat.mtimeMs < 30000) return false; }
        else {
          try { process.kill(owner.pid, 0); return false; }
          catch (e) { if (e.code !== 'ESRCH') return false; }
        }
        const recovery = path.join(this.folder, 'recovery.lock');
        try { await fs.mkdir(recovery); }
        catch (e) { if (e.code === 'EEXIST') return false; throw e; }
        try {
          // A different process may already have reclaimed the stale lock.
          const latest = await readJSON(path.join(this.lockDir, 'owner.json'), null);
          if (latest) {
            try { process.kill(latest.pid, 0); return false; }
            catch (e) { if (e.code !== 'ESRCH') return false; }
          }
          await fs.rm(this.lockDir, { recursive: true, force: true });
        } finally { await fs.rmdir(recovery); }
      }
    }
    return false;
  }
  async initialize() {
    const identityFile = path.join(this.folder, 'identity.json');
    let identity = await readJSON(identityFile, null);
    if (!identity) { identity = { id: randomUUID() }; await atomic(identityFile, identity); }
    if (!/^[a-f0-9-]{36}$/.test(identity.id)) throw Error('Invalid persistent device ID');
    this.device = identity.id;
    this.state = await readJSON(this.stateFile, null);
    if (!this.state) this.state = { version: 1, device: this.device, offset: 0, file: null, pending: [], accepted: 0, duplicates: 0, ignored: 0, invalid: 0, generation: this.options.backfillGeneration };
    if (this.state.version !== 1 || this.state.device !== this.device || !Number.isSafeInteger(this.state.offset) || this.state.offset < 0 || !Array.isArray(this.state.pending)) throw Error('Invalid state; refusing to reset progress');
    if (this.state.generation !== this.options.backfillGeneration) {
      this.state.offset = 0; this.state.file = null;
      this.state.generation = this.options.backfillGeneration;
      this.forceBackfill = true;
    }
    await this.save();
  }
  save() { return atomic(this.stateFile, this.state); }
  async capture() {
    const providers = await readJSON(path.join(this.directory, 'providers.json'), null);
    if (!providers || !Array.isArray(providers.providers)) throw Error('Cannot classify remote providers; capture paused');
    const remote = new Set(providers.providers.filter(p => p.preset === 'remote-magpie').map(p => p.id));
    let handle;
    try { handle = await fs.open(path.join(this.directory, 'usage.jsonl'), 'r'); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    try {
      const stat = await handle.stat();
      const file = `${stat.dev}:${stat.ino}`;
      if (this.state.file !== file || stat.size < this.state.offset) {
        const first = this.state.file == null && !this.forceBackfill;
        this.state.offset = first && !this.options.backfill ? stat.size : 0;
        // A first tail-only start in the middle of a write skips its remainder.
        this.state.skipPartial = false;
        if (this.state.offset > 0) {
          const last = Buffer.alloc(1); await handle.read(last, 0, 1, this.state.offset - 1);
          this.state.skipPartial = last[0] !== 10;
        }
        this.state.file = file;
      }
      const buffer = Buffer.alloc(512 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.state.offset);
      let start = 0;
      const allowed = new Set(this.options.includeProviders);
      for (let end = 0; end < bytesRead; end++) {
        if (buffer[end] !== 10) continue;
        if (this.state.pending.length >= 1000) break;
        const raw = buffer.subarray(start, end).toString('utf8').trim();
        if (this.state.skipPartial) this.state.skipPartial = false;
        else if (raw) {
          try {
            const row = recordOf(JSON.parse(raw), this.device, allowed, remote);
            if (row) this.state.pending.push(row); else this.state.ignored++;
          } catch {
            this.state.invalid++;
            // No raw line (potentially private) is copied into diagnostics.
            await fs.appendFile(path.join(this.folder, 'invalid.jsonl'), JSON.stringify({ offset: this.state.offset + start, sha256: hash(raw), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
          }
        }
        start = end + 1;
      }
      if (!start && bytesRead === buffer.length) throw Error('A usage line exceeds 512 KiB; capture paused');
      this.state.offset += start;
      // Capture and outbox are committed together BEFORE sending anything.
      await this.save();
    } finally { await handle.close(); }
  }
  async deliver() {
    if (!this.state.pending.length) return;
    const secrets = await readJSON(path.join(this.folder, 'credentials.json'), null);
    if (!text(secrets?.token)) throw Error('Configure usage-reporter/credentials.json with a gateway token');
    const batch = this.state.pending.slice(0, 200);
    const response = await this.fetch(`${this.options.endpoint}/v1/magpie/usage/requests`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${secrets.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(batch), signal: AbortSignal.any([AbortSignal.timeout(10000), this.abort.signal]),
    });
    if (!response.ok) throw Error(`Receiver HTTP ${response.status}; outbox retained`);
    const result = await response.json();
    if (!Number.isInteger(result.accepted) || !Number.isInteger(result.skipped) || result.accepted < 0 || result.skipped < 0 || result.accepted + result.skipped !== batch.length || !Array.isArray(result.records) || result.records.length !== batch.length || result.records.some((r, i) => r.rid !== batch[i].rid || r.index !== i || !['accepted', 'skipped'].includes(r.status))) throw Error('Invalid receiver acknowledgement; outbox retained');
    this.state.pending.splice(0, batch.length);
    this.state.accepted += result.accepted; this.state.duplicates += result.skipped;
    this.state.lastSuccess = new Date().toISOString();
    await this.save();
  }
  async cycle() {
    if (this.busy || !this.active) return;
    this.busy = true;
    try {
      if (!await this.stillEnabled()) { this.active = false; await this.status(null); return; }
      if (Date.now() < this.nextTry) return;
      await this.capture();
      await this.deliver();
      this.failures = 0; this.nextTry = 0;
      await this.status(null);
    } catch (e) {
      this.failures++;
      const delay = Math.min(60000, 1000 * 2 ** Math.min(this.failures - 1, 6));
      this.nextTry = Date.now() + delay;
      // Network errors can contain private endpoints; publish a fixed category.
      const safe = /^(Receiver HTTP \d+; outbox retained|Invalid receiver acknowledgement; outbox retained|Configure usage-reporter\/credentials.json with a gateway token|Cannot classify remote providers; capture paused|A usage line exceeds 512 KiB; capture paused)$/.test(e.message) ? e.message : 'Sync failed; progress retained (check connectivity and local files)';
      await this.status(safe).catch(() => {});
    } finally {
      this.busy = false;
      if (!this.active) await this.release();
    }
  }
  async status(error) {
    await atomic(path.join(this.folder, 'status.json'), { running: this.active, device: this.device, updated: new Date().toISOString(), lastSuccess: this.state.lastSuccess || null, pending: this.state.pending.length, accepted: this.state.accepted, duplicates: this.state.duplicates, ignored: this.state.ignored, invalid: this.state.invalid, error, retryAt: this.nextTry ? new Date(this.nextTry).toISOString() : null });
  }
  async release() {
    clearInterval(this.timer);
    if (this.locked) { this.locked = false; await fs.rm(this.lockDir, { recursive: true, force: true }); }
  }
  async start({ schedule = true } = {}) {
    if (this.stopped || !this.options.enabled || !await this.stillEnabled()) return false;
    if (!await this.acquire()) {
      if (schedule) {
        clearTimeout(this.standby);
        this.standby = setTimeout(() => {
          void this.start().catch(() => console.error('usage-reporter: cannot resume; check local state'));
        }, Math.min(1000, this.options.intervalMs));
        this.standby.unref?.();
      }
      return false;
    }
    try { await this.initialize(); }
    catch (e) { await this.release(); throw e; }
    this.abort = new AbortController(); this.active = true;
    if (schedule) {
      this.timer = setInterval(() => { void this.cycle(); }, this.options.intervalMs);
      this.timer.unref?.();
      void this.cycle();
    }
    return true;
  }
  async stop() {
    this.stopped = true; clearTimeout(this.standby);
    this.active = false; this.abort?.abort(); clearInterval(this.timer);
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.state && this.locked) await this.status(null).catch(() => {});
    await this.release();
  }
}
