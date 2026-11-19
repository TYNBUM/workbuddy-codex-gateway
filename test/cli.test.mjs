import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureModels, removeModels, restoreModels, managedEntries, matchesReasoningConfig } from '../cli.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const scratch = join(workspace, 'work', 'cli-tests');
mkdirSync(scratch, { recursive: true });
const config = { host: '127.0.0.1', port: 18789, models: [{ id: 'codex-test', name: 'Codex Test', upstream: 'test' }] };
const key = 'a'.repeat(64);

function fixture(t, document) {
  const directory = mkdtempSync(join(scratch, 'case-'));
  const targetPath = join(directory, 'models.json');
  const stateDirectory = join(directory, 'state');
  if (document !== undefined) writeFileSync(targetPath, JSON.stringify(document), 'utf8');
  t.after(() => {
    if (!resolve(directory).startsWith(`${resolve(scratch)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  });
  return { config, localKey: key, targetPath, stateDirectory };
}

const read = (context) => JSON.parse(readFileSync(context.targetPath, 'utf8'));

test('configure preserves unrelated models, backs up and remains idempotent', (t) => {
  const previous = { id: 'other', apiKey: 'fake-existing-secret', url: 'https://example.invalid/v1', custom: { keep: true } };
  const context = fixture(t, [previous]);
  const result = configureModels(context);
  assert.equal(result.changed, true);
  assert.equal(existsSync(result.backupPath), true);
  assert.deepEqual(read(context)[0], previous);
  assert.equal(read(context)[1].supportsToolCall, true);
  assert.equal(read(context)[1].useCustomProtocol, false);
  assert.equal(configureModels(context).changed, false);
});

test('configure rejects conflicting IDs without overwriting', (t) => {
  const previous = [{ id: 'codex-test', url: 'https://other.invalid/chat/completions', apiKey: 'fake' }];
  const context = fixture(t, previous);
  assert.throws(() => configureModels(context), /指向其他地址/);
  assert.deepEqual(read(context), previous);
  assert.equal(existsSync(context.stateDirectory), false);
});

test('configure preserves object container and other object properties', (t) => {
  const context = fixture(t, { models: [], availableModels: [], custom: { keep: true } });
  configureModels(context);
  const result = read(context);
  assert.equal(result.models.length, 1);
  assert.deepEqual(result.availableModels, []);
  assert.deepEqual(result.custom, { keep: true });
});

test('remove only matches ID plus exact URL and can be restored selectively', (t) => {
  const own = managedEntries(config, key)[0];
  const others = [{ id: 'other', url: own.url }, { id: 'codex-test', url: 'http://127.0.0.1:9999/v1/chat/completions' }];
  const context = fixture(t, [own, ...others]);
  assert.equal(removeModels(context).count, 1);
  assert.deepEqual(read(context), others);
  // Same ID now points elsewhere: recovery must not overwrite it.
  const restored = restoreModels(context);
  assert.deepEqual(restored.skipped, ['codex-test']);
  assert.deepEqual(read(context), others);
});

test('restore configure retains later unrelated models and skips edited managed model', (t) => {
  const context = fixture(t, []);
  configureModels(context);
  const document = read(context);
  document[0].name = 'user edited';
  document.push({ id: 'later-model', url: 'https://later.invalid' });
  writeFileSync(context.targetPath, JSON.stringify(document));
  const result = restoreModels(context);
  assert.equal(result.count, 0);
  assert.deepEqual(result.skipped, ['codex-test']);
  assert.deepEqual(read(context), document);
});

test('remove and restore preserve changes to other model entries', (t) => {
  const context = fixture(t, [{ id: 'other', name: 'before' }]);
  configureModels(context);
  removeModels(context);
  const document = read(context);
  document[0].name = 'after';
  writeFileSync(context.targetPath, JSON.stringify(document));
  assert.equal(restoreModels(context).count, 1);
  assert.equal(read(context)[0].name, 'after');
  assert.equal(read(context)[1].id, 'codex-test');
  assert.equal(restoreModels(context).count, 1);
  assert.deepEqual(read(context), [{ id: 'other', name: 'after' }]);
});

test('invalid existing JSON and structures are never replaced', (t) => {
  const context = fixture(t, { something: true });
  assert.throws(() => configureModels(context), /结构无法识别/);
  writeFileSync(context.targetPath, '{ broken json');
  assert.throws(() => configureModels(context), /不是有效 JSON/);
  assert.equal(readFileSync(context.targetPath, 'utf8'), '{ broken json');
});

test('configure missing file uses array and restore removes only inserted entries', (t) => {
  const context = fixture(t);
  configureModels(context);
  assert.equal(Array.isArray(read(context)), true);
  assert.equal(restoreModels(context).count, 1);
  assert.deepEqual(read(context), []);
});

test('configure upgrades existing model reasoning capabilities without duplicating it', (t) => {
  const previous = managedEntries(config, key)[0];
  const context = fixture(t, [previous, { id: 'other-model', custom: true }]);
  const reasoning = { defaultEffort: 'medium', supportedEfforts: ['medium', 'high', 'xhigh', 'max'] };
  context.config = { ...config, models: [{ ...config.models[0], reasoning }] };
  const desired = managedEntries(context.config, key)[0];
  assert.equal(matchesReasoningConfig(desired, previous), false);
  assert.equal(configureModels(context).changed, true);
  const result = read(context);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0].reasoning, reasoning);
  assert.deepEqual(result[1], { id: 'other-model', custom: true });
  assert.equal(matchesReasoningConfig(desired, result[0]), true);
  assert.equal(configureModels(context).changed, false);
  assert.equal(restoreModels(context).count, 1);
  assert.equal(read(context)[0].reasoning, undefined);
});

test('doctor reasoning check detects stale defaults, reduced levels and disabled reasoning', () => {
  const expected = { supportsReasoning: true, reasoning: { defaultEffort: 'medium', supportedEfforts: ['medium', 'high', 'xhigh', 'max'] } };
  assert.equal(matchesReasoningConfig(expected, { supportsReasoning: true }), false);
  assert.equal(matchesReasoningConfig(expected, { ...expected, reasoning: { ...expected.reasoning, defaultEffort: 'high' } }), false);
  assert.equal(matchesReasoningConfig(expected, { ...expected, reasoning: { ...expected.reasoning, supportedEfforts: ['medium', 'high'] } }), false);
  assert.equal(matchesReasoningConfig(expected, { ...expected, reasoning: { ...expected.reasoning, supportedEfforts: ['medium', 'high', 'high', 'max'] } }), false);
  assert.equal(matchesReasoningConfig(expected, { ...expected, supportsReasoning: false }), false);
  assert.equal(matchesReasoningConfig(expected, { ...expected, reasoning: { ...expected.reasoning, supportedEfforts: ['max', 'xhigh', 'high', 'medium'] } }), true);
});

test('legacy model settings remain compatible when no reasoning capability is declared', () => {
  const entry = managedEntries(config, key)[0];
  assert.equal(entry.reasoning, undefined);
  assert.equal(matchesReasoningConfig(entry, { supportsReasoning: true }), true);
});

test('managed reasoning capabilities do not share their array with source config', () => {
  const reasoning = { defaultEffort: 'medium', supportedEfforts: ['medium', 'high', 'xhigh', 'max'] };
  const configured = { ...config, models: [{ ...config.models[0], reasoning }] };
  const entry = managedEntries(configured, key)[0];
  entry.reasoning.supportedEfforts.pop();
  assert.deepEqual(reasoning.supportedEfforts, ['medium', 'high', 'xhigh', 'max']);
});
