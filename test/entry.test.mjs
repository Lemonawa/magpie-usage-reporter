import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ownsEntry } from '../entry.mjs';
import { normalizeOptions } from '../reporter.mjs';
const name = '@lemonawa/magpie-usage-reporter';
const directory = path.resolve('synthetic-config');
const root = path.resolve(directory, 'plugins/node_modules/@lemonawa/magpie-usage-reporter');
const match = (spec, dependencies = {}) => ownsEntry(spec, {root, directory, name, dependencies});

test('identifies GitHub-installed package using Magpie dependency mapping', () => {
  const spec = 'github:example/magpie-usage-reporter';
  assert.equal(match(spec, { [name]: spec }), true);
  assert.equal(match(spec), false);
  assert.equal(match('github:example/unrelated', { [name]: spec }), false);
});
test('local folders and exact npm package names match, similarly named packages do not', () => {
  assert.equal(match(root), true);
  assert.equal(match(`file://${root}`), true);
  assert.equal(match(name), true);
  assert.equal(match(`${name}@0.1.1`), true);
  assert.equal(match(`${name}-unrelated`), false);
});
test('fresh install has no deployment address and remains disabled', () => {
  const options = normalizeOptions();
  assert.equal(options.enabled, false);
  assert.equal(options.endpoint, '');
  assert.throws(() => normalizeOptions({ enabled: true }));
});
