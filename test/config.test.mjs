import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-config-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'gateway.config.json');
}

test('first run creates a generic template and asks for a model before any inference', (t) => {
  const file = fixture(t);
  assert.throws(() => loadConfig({ file }), /models\[\].upstream/);
  const example = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(example.networkProxy, null);
  assert.equal(example.models[0].upstream, 'REPLACE_WITH_YOUR_CODEX_MODEL');
  assert.equal(example.codexAuthFile, undefined);
  assert.equal(example.codexCommand, undefined);
});

test('configured model and custom settings survive subsequent loads', (t) => {
  const file = fixture(t);
  const original = JSON.stringify({ port: 18800, networkProxy: null, models: [{ id: 'my-model', name: 'My Model', upstream: 'account-model' }] });
  fs.writeFileSync(file, original);
  const loaded = loadConfig({ file });
  assert.equal(loaded.models[0].upstream, 'account-model');
  assert.equal(loaded.port, 18800);
  assert.equal(loaded.networkProxy, null);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('invalid configuration is never overwritten by a template', (t) => {
  const file = fixture(t);
  fs.writeFileSync(file, '{unfinished');
  assert.throws(() => loadConfig({ file }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{unfinished');
});

test('per-model reasoning defaults and supported levels are preserved', (t) => {
  const file = fixture(t);
  const reasoning = { defaultEffort: 'xhigh', supportedEfforts: ['medium', 'high', 'xhigh', 'max'] };
  const original = JSON.stringify({ models: [{ id: 'model', name: 'Model', upstream: 'account-model', reasoning }] });
  fs.writeFileSync(file, original);
  const loaded = loadConfig({ file });
  assert.deepEqual(loaded.models[0].reasoning, reasoning);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('reasoning configuration rejects malformed, duplicate and noncanonical levels', (t) => {
  const file = fixture(t);
  const invalid = [
    null,
    [],
    'high',
    {},
    { defaultEffort: 'medium', supportedEfforts: [] },
    { defaultEffort: 'medium', supportedEfforts: 'medium' },
    { defaultEffort: 'medium', supportedEfforts: ['medium', 'medium'] },
    { defaultEffort: 'medium', supportedEfforts: ['medium', 'ultra'] },
    { defaultEffort: 'medium', supportedEfforts: ['medium', 'HIGH'] },
    { defaultEffort: 'medium', supportedEfforts: ['medium', 'none'] },
    { defaultEffort: 'medium', supportedEfforts: ['medium', 'minimal'] },
    { defaultEffort: 'medium', supportedEfforts: ['medium', ' high'] },
    { defaultEffort: 'medium', supportedEfforts: ['medium', null] },
    { defaultEffort: 'high', supportedEfforts: ['medium'] },
    { supportedEfforts: ['medium'] },
  ];
  for (const reasoning of invalid) {
    const original = JSON.stringify({ models: [{ id: 'model', name: 'Model', upstream: 'account-model', reasoning }] });
    fs.writeFileSync(file, original);
    assert.throws(() => loadConfig({ file }), /Invalid reasoning/, JSON.stringify(reasoning));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('single supported reasoning level and legacy missing reasoning are accepted', (t) => {
  const file = fixture(t);
  const models = [
    { id: 'single', name: 'Single', upstream: 'account-model', reasoning: { defaultEffort: 'max', supportedEfforts: ['max'] } },
    { id: 'legacy', name: 'Legacy', upstream: 'account-model' },
  ];
  fs.writeFileSync(file, JSON.stringify({ models }));
  assert.deepEqual(loadConfig({ file }).models, models);
});
