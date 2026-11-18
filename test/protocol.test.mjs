import assert from 'node:assert/strict';
import test from 'node:test';
import { collectResponse, ProtocolError, ReasoningCache, toResponses, translateEvents } from '../src/protocol.mjs';

const model = 'test-model';
const tool = name => ({ type: 'function', function: { name, description: 'A test tool', parameters: { type: 'object', properties: {} } } });
const request = extra => ({ model, messages: [{ role: 'user', content: 'Hello' }], ...extra });
const events = async function* (list) { yield* list; };
const completed = output => ({ type: 'response.completed', response: { id: 'resp_test', model, status: 'completed', output, usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } });
const call = (name = 'read_file', args = '{"path":"a.txt"}', callId = 'call_one') => ({ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: args });
const text = value => ({ type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: value }] });

test('converts messages in place, images, tool calls, outputs, and drops unsupported backend fields', () => {
  const body = request({
    temperature: 0.2, max_tokens: 500, n: 1,
    tools: [tool('read_file')], tool_choice: { type: 'function', function: { name: 'read_file' } },
    messages: [
      { role: 'system', content: 'System one' },
      { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'high' } }] },
      { role: 'assistant', content: 'Reading', tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_one', content: 'result' },
      { role: 'system', content: 'System two' },
    ],
  });
  const { payload } = toResponses(body);
  assert.deepEqual(payload.input.map(x => x.role ?? x.type), ['developer', 'user', 'assistant', 'function_call', 'function_call_output', 'developer']);
  assert.equal(payload.input[1].content[1].type, 'input_image');
  assert.equal(payload.input[3].call_id, 'call_one');
  assert.equal(payload.input[4].output, 'result');
  assert.equal(payload.store, false);
  assert.equal(payload.stream, true);
  assert.equal(payload.instructions, '');
  assert.equal(payload.max_output_tokens, undefined);
  assert.equal(payload.temperature, undefined);
  assert.deepEqual(payload.tool_choice, { type: 'function', name: 'read_file' });
});

test('names that are long or contain punctuation are mapped and restored', async () => {
  const original = 'mcp::tool.' + 'long-'.repeat(30);
  const { payload, toolNames } = toResponses(request({ tools: [tool(original)] }));
  const wire = payload.tools[0].name;
  assert.match(wire, /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(toolNames.get(wire), original);
  const result = await collectResponse(events([completed([call(wire, '{}')])]), { model, toolNames });
  assert.equal(result.choices[0].message.tool_calls[0].function.name, original);
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
});

test('rejects unsupported input instead of silently discarding it', () => {
  for (const extra of [{ n: 2 }, { stop: ['end'] }, { audio: {} }, { functions: [] }, { tool_choice: 'required' }]) {
    assert.throws(() => toResponses(request(extra)), ProtocolError);
  }
  assert.throws(() => toResponses(request({ messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }] })), /Unsupported/);
  assert.throws(() => toResponses(request({ messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'tool', arguments: 'broken' } }] }] })), /valid JSON/);
  assert.throws(() => toResponses(request({ messages: [{ role: 'tool', tool_call_id: 'missing', content: 'x' }] })), /matching pending/);
});

test('streams Unicode text and reconciles done events without duplication', async () => {
  const input = [
    { type: 'response.created', response: { id: 'resp_unicode', model, created_at: 7 } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: '你好' },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: ' 👋' },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text: '你好 👋' },
    { type: 'response.output_item.done', output_index: 0, item: text('你好 👋') },
    completed([text('你好 👋')]),
  ];
  const chunks = [];
  for await (const chunk of translateEvents(events(input), { model, includeUsage: true })) chunks.push(chunk);
  assert.equal(chunks.map(c => c.choices[0]?.delta.content ?? '').join(''), '你好 👋');
  assert.equal(chunks[0].id, 'resp_unicode');
  assert.equal(chunks.at(-2).choices[0].finish_reason, 'stop');
  assert.deepEqual(chunks.at(-1).choices, []);
  assert.equal(chunks.at(-1).usage.total_tokens, 6);
});

test('streams multiple tool calls with stable independent indexes and arguments', async () => {
  const first = call('read_file', '{"path":"一.txt"}', 'a');
  const second = call('read_file', '{"path":"two.txt"}', 'b');
  const input = [
    { type: 'response.output_item.added', output_index: 0, item: { ...first, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"一.txt"}' },
    { type: 'response.function_call_arguments.done', output_index: 0, arguments: first.arguments },
    { type: 'response.output_item.done', output_index: 0, item: first },
    { type: 'response.output_item.added', output_index: 1, item: { ...second, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: second.arguments },
    completed([first, second]),
  ];
  const result = await collectResponse(events(input), { model });
  assert.deepEqual(result.choices[0].message.tool_calls.map(c => [c.id, c.function.arguments]), [['a', first.arguments], ['b', second.arguments]]);
  assert.equal(result.choices[0].message.content, null);
});

test('retains encrypted reasoning for a tool-result follow-up and only inserts group once', async () => {
  const cache = new ReasoningCache();
  const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED', summary: [] };
  const first = call('read_file', '{}', 'a');
  const second = call('read_file', '{}', 'b');
  const result = await collectResponse(events([completed([reasoning, first, second])]), { model, reasoningCache: cache });
  const body = request({ messages: [
    { role: 'user', content: 'Read' },
    result.choices[0].message,
    { role: 'tool', tool_call_id: 'a', content: 'A' },
    { role: 'tool', tool_call_id: 'b', content: 'B' },
  ] });
  const { payload } = toResponses(body, { reasoningCache: cache });
  assert.equal(payload.input.filter(x => x.type === 'reasoning').length, 1);
  assert.deepEqual(payload.input[1], reasoning);
  assert.equal(payload.input[2].call_id, 'a');
  assert.equal(payload.input[4].output, 'A');
});

test('reasoning cache expires and is bounded', () => {
  let now = 0;
  const cache = new ReasoningCache({ maxEntries: 1, ttlMs: 10, now: () => now });
  const reasoning = { type: 'reasoning', encrypted_content: 'encrypted', summary: [] };
  cache.remember({ id: 'one', output: [reasoning, call('tool', '{}', 'one')] }, model);
  cache.remember({ id: 'two', output: [reasoning, call('tool', '{}', 'two')] }, model);
  assert.equal(cache.entries.size, 1);
  assert.deepEqual(cache.get(model, [call('tool', '{}', 'one')]), []);
  now = 11;
  assert.deepEqual(cache.get(model, [call('tool', '{}', 'two')]), []);
  assert.equal(cache.bytes, 0);
});

test('model aliases do not lose encrypted reasoning on tool-result follow-up', async () => {
  const cache = new ReasoningCache();
  const reasoning = { type: 'reasoning', id: 'rs_alias', encrypted_content: 'ENCRYPTED', summary: [] };
  const result = await collectResponse(events([completed([reasoning, call('read_file', '{}', 'alias-call')])]), {
    model: 'workbuddy-codex', cacheModel: model, reasoningCache: cache,
  });
  assert.equal(result.model, 'workbuddy-codex');
  const { payload } = toResponses(request({ model: 'workbuddy-codex', messages: [
    { role: 'user', content: 'Read the file' }, result.choices[0].message,
    { role: 'tool', tool_call_id: 'alias-call', content: 'file contents' },
  ] }), { model, reasoningCache: cache });
  assert.equal(payload.model, model);
  assert.deepEqual(payload.input[1], reasoning);
});

test('reasoning cache compares JSON arguments semantically after WorkBuddy reserialization', async () => {
  const cache = new ReasoningCache();
  const reasoning = { type: 'reasoning', id: 'rs_reformatted', encrypted_content: 'ENCRYPTED', summary: [] };
  const original = '{"path":"一.txt", "options":{"z":2,"a":1}, "lines":[1,2]}';
  const reformatted = '{\n  "lines": [1, 2], "options": {"a": 1, "z": 2}, "path": "一.txt"\n}';
  const first = call('read_file', original, 'reformatted-call');
  await collectResponse(events([completed([reasoning, first])]), { model, reasoningCache: cache });
  assert.deepEqual(cache.get(model, [call('read_file', reformatted, 'reformatted-call')]), [reasoning]);
  // Still bind the cache to the model, call id, function name and actual values.
  assert.deepEqual(cache.get('another-model', [call('read_file', reformatted, 'reformatted-call')]), []);
  assert.deepEqual(cache.get(model, [call('read_file', reformatted, 'another-call')]), []);
  assert.deepEqual(cache.get(model, [call('write_file', reformatted, 'reformatted-call')]), []);
  assert.deepEqual(cache.get(model, [call('read_file', reformatted.replace('[1, 2]', '[2, 1]'), 'reformatted-call')]), []);
  assert.deepEqual(cache.get(model, [call('read_file', reformatted.replace('"a": 1', '"a": 9'), 'reformatted-call')]), []);
  const { payload } = toResponses(request({ messages: [
    { role: 'user', content: 'Read' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'reformatted-call', type: 'function', function: { name: 'read_file', arguments: reformatted } }] },
    { role: 'tool', tool_call_id: 'reformatted-call', content: 'contents' },
  ] }), { reasoningCache: cache });
  assert.deepEqual(payload.input[1], reasoning);
  assert.equal(payload.input[2].arguments, reformatted);
});

test('EOF, upstream failure, and incomplete generation never produce successful completion', async () => {
  for (const input of [
    [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial' }],
    [{ type: 'response.failed', response: { error: { message: 'Quota reached' } } }],
    [{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }],
  ]) {
    await assert.rejects(collectResponse(events(input), { model }), error => error.status === 502);
    const chunks = [];
    await assert.rejects(async () => { for await (const chunk of translateEvents(events(input), { model })) chunks.push(chunk); });
    assert.ok(chunks.every(chunk => !chunk.choices.some(choice => choice.finish_reason)));
  }
});

test('invalid completed tool arguments and conflicting completion are errors', async () => {
  await assert.rejects(collectResponse(events([completed([call('tool', '{broken')])]), { model }), /valid JSON object/);
  await assert.rejects(collectResponse(events([completed([call('tool', '[]')])]), { model }), /valid JSON object/);
  await assert.rejects(collectResponse(events([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    completed([text('different')]),
  ]), { model }), /differs/);
  await assert.rejects(collectResponse(events([
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    completed([{ type: 'message', role: 'assistant', content: [] }]),
  ]), { model }), /omitted streamed content/);
  await assert.rejects(collectResponse(events([
    { type: 'response.output_item.added', output_index: 0, item: call('tool', '{}') },
    completed([{ ...call('tool', '{}'), arguments: undefined }]),
  ]), { model }), /missing arguments/);
});

test('final-only responses, refusal, and structured output are supported', async () => {
  const result = await collectResponse(events([completed([{ ...text(''), content: [{ type: 'refusal', refusal: 'Cannot do that.' }] }])]), { model });
  assert.equal(result.choices[0].message.refusal, 'Cannot do that.');
  assert.equal(result.choices[0].finish_reason, 'stop');
  const { payload } = toResponses(request({ response_format: { type: 'json_schema', json_schema: { name: 'test', strict: true, schema: { type: 'object', properties: {} } } } }));
  assert.equal(payload.text.format.type, 'json_schema');
  assert.equal(payload.text.format.strict, true);
});
