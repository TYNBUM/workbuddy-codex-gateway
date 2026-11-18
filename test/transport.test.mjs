import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSSE } from '../src/sse.mjs';
import { createAuthProvider, readCodexAuth } from '../src/auth.mjs';

async function* bytes(value) { for (const byte of Buffer.from(value)) yield Buffer.of(byte); }
test('SSE handles CRLF and UTF-8 split at every byte, and multiline data', async () => {
  const result = [];
  for await (const event of parseSSE(bytes(': ping\r\ndata: {"type":"text",\r\ndata: "text":"你好"}\r\n\r\ndata: [DONE]\r\n\r\n'))) result.push(event);
  assert.deepEqual(result, [{ type: 'text', text: '你好' }]);
});
test('SSE rejects truncated events, malformed JSON and oversized events', async () => {
  for (const [value, limit] of [['data: {"x":1}', 100], ['data: {bad}\n\n', 100], ['data: {"x":"too long"}\n\n', 5]]) {
    await assert.rejects(async () => { for await (const event of parseSSE(bytes(value), limit)) void event; });
  }
});
test('API key credentials never silently become billed API requests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-test-'));
  const file = path.join(dir, 'auth.json');
  try {
    fs.writeFileSync(file, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'fake' }));
    assert.throws(() => readCodexAuth(file), /ChatGPT/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('concurrent expired credentials trigger one Codex-managed refresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-auth-test-'));
  const file = path.join(dir, 'auth.json');
  const save = (expires) => fs.writeFileSync(file, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'x.' + Buffer.from(JSON.stringify({ exp: expires })).toString('base64url') + '.x', account_id: 'test-account' } }));
  let calls = 0;
  try {
    save(1);
    const get = createAuthProvider({ codexAuthFile: file }, async () => { calls++; await new Promise((r) => setTimeout(r, 15)); save(Math.floor(Date.now() / 1000) + 3600); });
    const result = await Promise.all([get(), get(), get()]);
    assert.equal(calls, 1);
    assert.equal(result.length, 3);
    assert.equal(result[0].accountId, 'test-account');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
