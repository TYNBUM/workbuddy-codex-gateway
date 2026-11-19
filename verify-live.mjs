// Explicit live smoke test: uses a small amount of the signed-in Codex quota.
// The synthetic echo tool is handled here; no filesystem or shell tools run.
import assert from 'node:assert/strict';
import { loadConfig, ensureLocalKey } from './src/config.mjs';

const config = loadConfig();
const model = config.models[0].id;
const supported = config.models[0].reasoning?.supportedEfforts;
const effort = !supported || supported.includes('low') ? 'low' : config.models[0].reasoning?.defaultEffort || supported[0];
const url = `http://${config.host}:${config.port}/v1/chat/completions`;
const key = ensureLocalKey();
const tools = [{ type: 'function', function: { name: 'gateway_echo', description: 'Echo the test message.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } } }];
const messages = [{ role: 'user', content: 'Call gateway_echo exactly once with text GATEWAY_TOOL_OK. After receiving its result, reply with that exact result only.' }];
async function post(body) {
  const response = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model, reasoning_effort: effort, ...body }), signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response;
}
try {
  const result = await (await post({ messages, tools, tool_choice: { type: 'function', function: { name: 'gateway_echo' } } })).json();
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  const message = result.choices[0].message;
  assert.equal(message.tool_calls.length, 1);
  const call = message.tool_calls[0];
  assert.equal(call.function.name, 'gateway_echo');
  assert.equal(JSON.parse(call.function.arguments).text, 'GATEWAY_TOOL_OK');
  console.log('[PASS] Real Codex function call, name, arguments and call ID.');
  messages.push(message, { role: 'tool', tool_call_id: call.id, content: 'GATEWAY_TOOL_OK' });
  const response = await post({ messages, tools, tool_choice: 'none', stream: true, stream_options: { include_usage: true } });
  const raw = await response.text();
  assert.match(raw, /data: \[DONE\]/);
  const chunks = raw.split(/\r?\n/).filter((line) => line.startsWith('data: ') && !line.includes('[DONE]')).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.some((chunk) => chunk.error), false);
  const text = chunks.map((chunk) => chunk.choices?.[0]?.delta?.content || '').join('');
  assert.equal(text.trim(), 'GATEWAY_TOOL_OK');
  assert.ok(chunks.some((chunk) => chunk.choices?.[0]?.finish_reason === 'stop'));
  assert.ok(chunks.some((chunk) => chunk.usage?.total_tokens > 0));
  console.log('[PASS] Tool-result follow-up, streamed answer, finish_reason and usage.');
  console.log(JSON.stringify({ model, result: 'GATEWAY_TOOL_OK', requests: 2 }));
} catch (error) { console.error(error.message.split(key).join('[REDACTED]')); process.exitCode = 1; }
