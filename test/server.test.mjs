import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { startServer } from '../src/server.mjs';

const config = { host: '127.0.0.1', port: 0, defaultEffort: 'medium', maxBodyBytes: 4096, requestTimeoutMs: 1000, maxConcurrentRequests: 2, models: [{ id: 'codex-test', name: 'Test', upstream: 'test-model' }] };
const auth = async () => ({ accessToken: 'test-token', accountId: 'test-account' });
const completed = { type: 'response.completed', response: { id: 'resp_test', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] }], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } };
function upstream(events = [completed]) { return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
async function fixture(t, overrides = {}, dependencies = {}) {
  const server = await startServer({ ...config, ...overrides }, { key: 'test-key', getAuth: auth, fetch: async () => upstream(), quiet: true, ...dependencies });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, request: (body, headers = {}) => fetch(base + '/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }) };
}
const request = { model: 'codex-test', messages: [{ role: 'user', content: 'hello' }] };

test('malformed request URL cannot crash the service', async (t) => {
  const f = await fixture(t);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.server.address().port, path: '//' }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(status, 400);
  assert.equal((await fetch(f.base + '/health')).status, 200);
});

test('real backend SSE remains valid when Content-Type is omitted', async (t) => {
  const f = await fixture(t, {}, { fetch: async () => { const response = upstream(); response.headers.delete('content-type'); return response; } });
  assert.equal((await f.request(request)).status, 200);
});

test('HTTP authentication, routing, invalid JSON and body limits', async (t) => {
  let calls = 0;
  const f = await fixture(t, {}, { fetch: async () => { calls++; return upstream(); } });
  assert.equal((await f.request(request, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await f.request({ ...request, model: 'wrong' })).status, 400);
  assert.equal((await f.request('{broken')).status, 400);
  assert.equal((await f.request('x'.repeat(5000))).status, 413);
  assert.equal(calls, 0);
  const health = await (await fetch(f.base + '/health')).json();
  assert.equal(health.service, 'workbuddy-codex-gateway');
  assert.equal(JSON.stringify(health).includes('test-token'), false);
});
test('nonstream completion uses Codex auth and only configured model', async (t) => {
  const f = await fixture(t, {}, { fetch: async (url, options) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.headers.authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'test-model'); assert.equal(payload.store, false); assert.equal(payload.stream, true);
    return upstream();
  } });
  const res = await f.request(request); assert.equal(res.status, 200);
  const result = await res.json(); assert.equal(result.choices[0].message.content, 'hello');
  assert.equal(result.model, 'codex-test');
});
test('SSE fails visibly on truncated stream and never sends DONE', async (t) => {
  const f = await fixture(t, {}, { fetch: async () => upstream([{ type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'partial' }]) });
  const res = await f.request({ ...request, stream: true });
  const data = await res.text();
  assert.match(data, /error/); assert.doesNotMatch(data, /\[DONE\]/);
});
test('upstream 401 triggers one native credential refresh; 429 is preserved', async (t) => {
  const force = []; let calls = 0;
  const f = await fixture(t, {}, { getAuth: async (refresh) => { force.push(refresh); return auth(); }, fetch: async () => ++calls === 1 ? new Response('{}', { status: 401 }) : new Response('{"error":{"message":"limit"}}', { status: 429, headers: { 'retry-after': '12' } }) });
  const response = await f.request(request);
  assert.deepEqual(force, [false, true]); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '12');
});
test('timeout aborts upstream and returns 504', async (t) => {
  let cancelled = false;
  const f = await fixture(t, { requestTimeoutMs: 25 }, { fetch: async (_url, options) => { await once(options.signal, 'abort'); cancelled = true; throw new Error('aborted'); } });
  assert.equal((await f.request(request)).status, 504); assert.equal(cancelled, true);
});
test('timeout also covers a client that never finishes its request body', async (t) => {
  const f = await fixture(t, { requestTimeoutMs: 25 });
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: f.server.address().port, path: '/v1/chat/completions', method: 'POST', headers: { authorization: 'Bearer test-key', 'content-type': 'application/json', 'content-length': 1000 } }, (res) => { res.resume(); resolve(res.statusCode); req.destroy(); });
    req.on('error', reject); req.write('{');
  });
  assert.equal(status, 504);
});
test('closing a streaming client cancels upstream generation', async (t) => {
  let signal;
  const f = await fixture(t, {}, { fetch: async (_url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","item_id":"m","output_index":0,"content_index":0,"delta":"hello"}\n\n'));
        signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      }
    }), { headers: { 'content-type': 'text/event-stream' } });
  } });
  const response = await f.request({ ...request, stream: true });
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  if (!signal.aborted) await once(signal, 'abort');
  assert.equal(signal.aborted, true);
});

const reasoning = {defaultEffort: 'medium', supportedEfforts: ['medium', 'high', 'xhigh', 'max']};
test('all configured effort levels are forwarded exactly and confirmed by upstream headers', async (t) => {
  const f = await fixture(t, {models: [{...config.models[0], reasoning}]}, {fetch: async (_url, options) => {
    const payload = JSON.parse(options.body);
    return upstream([{...completed, response: {...completed.response, reasoning: {effort: payload.reasoning.effort}, usage: {input_tokens: 1, output_tokens: 5, total_tokens: 6, output_tokens_details: {reasoning_tokens: 3}}}}]);
  }});
  for (const effort of reasoning.supportedEfforts) {
    const response = await f.request({...request, reasoning_effort: effort});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-codex-reasoning-effort'), effort);
    assert.equal(response.headers.get('x-codex-upstream-reasoning-effort'), effort);
    await response.json();
    const health = await (await fetch(f.base + '/health')).json();
    assert.equal(health.lastCompletion.requestedEffort, effort);
    assert.equal(health.lastCompletion.effectiveEffort, effort);
    assert.equal(health.lastCompletion.upstreamEffort, effort);
    assert.equal(health.lastCompletion.reasoningTokens, 3);
  }
});

test('per-model default and nested effort work while explicit effort takes precedence', async (t) => {
  const seen = [];
  const f = await fixture(t, {models: [{...config.models[0], reasoning: {...reasoning, defaultEffort: 'xhigh'}}]}, {fetch: async (_url, options) => {
    seen.push(JSON.parse(options.body).reasoning.effort); return upstream();
  }});
  for (const body of [request, {...request, reasoning: {effort: 'max'}}, {...request, reasoning: {effort: 'max'}, reasoning_effort: 'high'}]) {
    const response = await f.request(body); assert.equal(response.status, 200); await response.arrayBuffer();
  }
  assert.deepEqual(seen, ['xhigh', 'max', 'high']);
});

test('unsupported ultra is rejected without silently downgrading or contacting upstream', async (t) => {
  let calls = 0;
  const f = await fixture(t, {models: [{...config.models[0], reasoning}]}, {fetch: async () => {calls++; return upstream();}});
  const response = await f.request({...request, reasoning_effort: 'ultra'});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'unsupported_reasoning_effort');
  assert.equal(calls, 0);
});

test('missing upstream confirmation is not fabricated from the requested effort', async (t) => {
  const f = await fixture(t);
  const response = await f.request({...request, reasoning_effort: 'high'});
  assert.equal(response.headers.get('x-codex-reasoning-effort'), 'high');
  assert.equal(response.headers.get('x-codex-upstream-reasoning-effort'), null);
  await response.arrayBuffer();
});
