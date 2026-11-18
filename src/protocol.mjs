import { createHash, randomUUID } from 'node:crypto';

/** Errors are deliberately distinct from an upstream successful completion. */
export class ProtocolError extends Error {
  constructor(message, { status = 400, code = 'invalid_request_error' } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.status = this.statusCode = status;
    this.type = status >= 500 ? 'upstream_error' : 'invalid_request_error';
    this.code = code;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const bad = message => { throw new ProtocolError(message); };
const upstreamBad = (message, code = 'invalid_upstream_response') => {
  throw new ProtocolError(message, { status: 502, code });
};

function requireString(value, label, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && !value.length)) bad(`${label} must be a string${empty ? '' : ' that is not empty'}.`);
  return value;
}

function parseArguments(value, label, upstream = false) {
  let parsed;
  try {
    if (typeof value !== 'string') throw new Error();
    parsed = JSON.parse(value);
    if (!isObject(parsed)) throw new Error();
  } catch {
    if (upstream) upstreamBad(`${label} must be a valid JSON object.`, 'invalid_tool_arguments');
    bad(`${label} must be a string containing a valid JSON object.`);
  }
  return parsed;
}

function canonicalArguments(value) {
  try {
    // WorkBuddy can parse and reserialize arguments between tool execution and
    // the follow-up request. Object-key order/whitespace do not change JSON
    // meaning; array order and the actual primitive values still matter.
    return JSON.stringify(JSON.parse(value), (_key, item) => isObject(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
      : item);
  } catch {
    // Invalid or excessively nested values are never considered a cache hit.
    return undefined;
  }
}

/** Only encrypted reasoning is retained, in memory, bounded by age/count/bytes. */
export class ReasoningCache {
  constructor({ maxEntries = 512, ttlMs = 60 * 60 * 1000, maxBytes = 16 * 1024 * 1024, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.maxBytes = maxBytes;
    this.now = now;
    this.entries = new Map();
    this.bytes = 0;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.delete(key);
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.delete(this.entries.keys().next().value);
  }

  remember(response, model) {
    const reasoning = (response.output ?? []).filter(item => item.type === 'reasoning' && typeof item.encrypted_content === 'string');
    if (!reasoning.length) return;
    const group = response.id || randomUUID();
    for (const item of response.output ?? []) {
      if (item.type !== 'function_call') continue;
      const argumentsKey = canonicalArguments(item.arguments);
      if (argumentsKey === undefined) continue;
      const entry = { group, reasoning: clone(reasoning), name: item.name, argumentsKey, expiresAt: this.now() + this.ttlMs };
      entry.bytes = Buffer.byteLength(JSON.stringify(entry));
      if (entry.bytes > this.maxBytes) continue;
      const key = `${model}\0${item.call_id}`;
      this.delete(key);
      this.entries.set(key, entry);
      this.bytes += entry.bytes;
    }
    this.prune();
  }

  get(model, calls, seenGroups = new Set()) {
    this.prune();
    const output = [];
    for (const call of calls) {
      const entry = this.entries.get(`${model}\0${call.call_id}`);
      if (!entry || entry.name !== call.name || entry.argumentsKey !== canonicalArguments(call.arguments) || seenGroups.has(entry.group)) continue;
      seenGroups.add(entry.group);
      output.push(...clone(entry.reasoning));
    }
    return output;
  }
}

function toolNameMappings(body) {
  const names = new Set();
  for (const tool of body.tools ?? []) {
    if (!isObject(tool) || tool.type !== 'function' || !isObject(tool.function)) bad('Only function tools are supported.');
    names.add(requireString(tool.function.name, 'tools[].function.name'));
  }
  for (const message of body.messages) {
    if (!isObject(message)) bad('Every message must be an object.');
    if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) bad('message.tool_calls must be an array.');
    for (const call of message.tool_calls ?? []) {
      if (!isObject(call) || call.type !== 'function' || !isObject(call.function)) bad('Only function tool calls are supported.');
      names.add(requireString(call.function.name, 'tool_calls[].function.name'));
    }
  }
  const toWire = new Map();
  const fromWire = new Map();
  // Reserve valid names first, including any that look like generated names.
  for (const name of names) {
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) {
      toWire.set(name, name);
      fromWire.set(name, name);
    }
  }
  for (const name of names) {
    if (toWire.has(name)) continue;
    if (name.length > 4096) bad('Tool names cannot exceed 4096 characters.');
    const hash = createHash('sha256').update(name).digest('hex');
    let mapped = `wb_${hash.slice(0, 48)}`;
    let suffix = 0;
    while (fromWire.has(mapped)) mapped = `wb_${hash.slice(0, 48)}_${++suffix}`;
    toWire.set(name, mapped);
    fromWire.set(mapped, name);
  }
  return { toWire, fromWire };
}

function contentParts(content, role) {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
  if (!Array.isArray(content)) bad('Message content must be a string, an array, or null.');
  return content.map(part => {
    if (!isObject(part)) bad('Message content parts must be objects.');
    if (part.type === 'text') return { type: textType, text: requireString(part.text, 'content text', { empty: true }) };
    if (part.type === 'image_url' && role === 'user') {
      if (!isObject(part.image_url)) bad('image_url must be an object.');
      const url = requireString(part.image_url.url, 'image_url.url');
      if (!/^(https?:\/\/|data:image\/)/i.test(url)) bad('Image URLs must use http(s) or a data:image URL.');
      const detail = part.image_url.detail ?? 'auto';
      if (!['auto', 'low', 'high', 'original'].includes(detail)) bad('Unsupported image detail.');
      return { type: 'input_image', image_url: url, detail };
    }
    if (part.type === 'refusal' && role === 'assistant') return { type: 'refusal', refusal: requireString(part.refusal, 'refusal', { empty: true }) };
    bad(`Unsupported ${role} content type: ${String(part.type)}.`);
  });
}

/** Return wire payload plus a name map which must also be used for the response. */
export function toResponses(body, { model, effort = 'medium', reasoningCache } = {}) {
  if (!isObject(body)) bad('Request must be a JSON object.');
  if (!Array.isArray(body.messages) || !body.messages.length) bad('messages must be a nonempty array.');
  if (body.n !== undefined && body.n !== 1) bad('This gateway supports n=1 only.');
  if (body.stop !== undefined && body.stop !== null && !(Array.isArray(body.stop) && body.stop.length === 0)) bad('stop sequences are not supported by the Codex backend.');
  if (body.logprobs || body.top_logprobs) bad('Log probabilities are not supported by this gateway.');
  if (body.audio || (body.modalities && JSON.stringify(body.modalities) !== '["text"]')) bad('Audio/video output is not supported.');
  if (body.functions || body.function_call) bad('Use tools/tool_choice instead of the legacy functions/function_call fields.');
  if (body.tools !== undefined && !Array.isArray(body.tools)) bad('tools must be an array.');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') bad('stream must be a boolean.');
  const resolvedModel = requireString(model ?? body.model, 'model');
  const { toWire, fromWire } = toolNameMappings(body);
  const input = [];
  const seenGroups = new Set();
  const seenCalls = new Set();
  const pendingCalls = new Set();
  for (const message of body.messages) {
    const role = message.role;
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) bad(`Unsupported message role: ${String(role)}.`);
    if (message.function_call || message.audio) bad('Legacy function calls and audio messages are not supported.');
    if (role === 'tool') {
      const callId = requireString(message.tool_call_id, 'tool_call_id');
      if (!pendingCalls.has(callId)) bad(`Tool result has no matching pending tool call: ${callId}.`);
      pendingCalls.delete(callId);
      if (typeof message.content === 'string') {
        input.push({ type: 'function_call_output', call_id: callId, output: message.content });
      } else if (Array.isArray(message.content) && message.content.every(part => isObject(part) && part.type === 'text' && typeof part.text === 'string')) {
        input.push({ type: 'function_call_output', call_id: callId, output: message.content.map(part => part.text).join('\n') });
      } else bad('Tool results must contain text; unsupported content is not silently discarded.');
      continue;
    }
    if (pendingCalls.size) bad('Every assistant tool call must be followed by its tool result before the next message.');
    if (role !== 'assistant' && message.tool_calls?.length) bad('Only assistant messages can contain tool calls.');
    const calls = (message.tool_calls ?? []).map(call => {
      const callId = requireString(call.id, 'tool_calls[].id');
      if (seenCalls.has(callId)) bad(`Duplicate tool call id: ${callId}.`);
      seenCalls.add(callId);
      pendingCalls.add(callId);
      parseArguments(call.function.arguments, 'tool_calls[].function.arguments');
      return { type: 'function_call', call_id: callId, name: toWire.get(call.function.name), arguments: call.function.arguments };
    });
    if (calls.length && reasoningCache) input.push(...reasoningCache.get(resolvedModel, calls, seenGroups));
    const content = contentParts(message.content, role);
    if (message.refusal !== undefined && message.refusal !== null) {
      if (role !== 'assistant') bad('refusal is only valid on assistant messages.');
      content.push({ type: 'refusal', refusal: requireString(message.refusal, 'refusal', { empty: true }) });
    }
    if (content.length || (!calls.length && ['system', 'developer', 'user'].includes(role))) {
      input.push({ role: role === 'system' ? 'developer' : role, content: content.length ? content : [{ type: 'input_text', text: '' }] });
    }
    input.push(...calls);
  }
  if (pendingCalls.size) bad('The request is missing a result for an assistant tool call.');
  const payload = {
    model: resolvedModel, instructions: '', input, stream: true, store: false,
    include: ['reasoning.encrypted_content'],
  };
  const selectedEffort = body.reasoning_effort ?? body.reasoning?.effort ?? effort;
  if (selectedEffort) {
    if (!['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(selectedEffort)) bad('Unsupported reasoning effort.');
    payload.reasoning = { effort: selectedEffort === 'minimal' ? 'low' : selectedEffort };
  }
  if (body.tools?.length) {
    const uniqueNames = new Set();
    payload.tools = body.tools.map(tool => {
      const f = tool.function;
      if (uniqueNames.has(f.name)) bad(`Duplicate tool name: ${f.name}.`);
      uniqueNames.add(f.name);
      if (f.parameters !== undefined && !isObject(f.parameters)) bad('Function parameters must be a JSON Schema object.');
      if (f.strict !== undefined && typeof f.strict !== 'boolean') bad('Function strict must be a boolean.');
      const result = { type: 'function', name: toWire.get(f.name), parameters: clone(f.parameters ?? { type: 'object', properties: {} }), strict: f.strict ?? false };
      if (f.description !== undefined) result.description = requireString(f.description, 'function.description', { empty: true });
      return result;
    });
  }
  if (body.tool_choice !== undefined) {
    const choice = body.tool_choice;
    if (typeof choice === 'string') {
      if (!['auto', 'none', 'required'].includes(choice)) bad('Unsupported tool_choice.');
      if (choice === 'required' && !payload.tools?.length) bad('tool_choice=required needs tools.');
      payload.tool_choice = choice;
    } else if (isObject(choice) && choice.type === 'function' && isObject(choice.function)) {
      if (!body.tools?.some(tool => tool.function.name === choice.function.name)) bad('tool_choice names a function missing from tools.');
      payload.tool_choice = { type: 'function', name: toWire.get(choice.function.name) };
    } else bad('Unsupported tool_choice.');
  }
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== 'boolean') bad('parallel_tool_calls must be boolean.');
    payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.response_format !== undefined) {
    const format = body.response_format;
    if (!isObject(format)) bad('response_format must be an object.');
    if (format.type === 'json_object' || format.type === 'text') payload.text = { format: { type: format.type } };
    else if (format.type === 'json_schema' && isObject(format.json_schema)) {
      const schema = format.json_schema;
      requireString(schema.name, 'json_schema.name');
      if (!isObject(schema.schema)) bad('json_schema.schema must be an object.');
      payload.text = { format: { type: 'json_schema', name: schema.name, schema: clone(schema.schema) } };
      if (schema.strict !== undefined) payload.text.format.strict = schema.strict;
      if (schema.description !== undefined) payload.text.format.description = schema.description;
    } else bad('Unsupported response_format.');
  }
  // Backend rejects Chat Completions sampling parameters and length budgets.
  // Do not forward temperature/top_p/max_tokens/max_completion_tokens/etc.
  return { payload, toolNames: fromWire };
}

export function normalizeUsage(usage = {}) {
  const input = Number(usage.input_tokens ?? 0);
  const output = Number(usage.output_tokens ?? 0);
  return {
    prompt_tokens: input, completion_tokens: output,
    total_tokens: Number(usage.total_tokens ?? input + output),
    ...(usage.input_tokens_details ? { prompt_tokens_details: clone(usage.input_tokens_details) } : {}),
    ...(usage.output_tokens_details ? { completion_tokens_details: clone(usage.output_tokens_details) } : {}),
  };
}

class EventTranslator {
  constructor({ model, cacheModel = model, toolNames = new Map(), reasoningCache, includeUsage = false } = {}) {
    this.model = model;
    this.cacheModel = cacheModel;
    this.toolNames = toolNames;
    this.reasoningCache = reasoningCache;
    this.includeUsage = includeUsage;
    this.id = `chatcmpl-${randomUUID().replaceAll('-', '')}`;
    this.created = Math.floor(Date.now() / 1000);
    this.items = new Map();
    this.ids = new Map();
    this.toolCount = 0;
    this.started = false;
    this.completed = false;
    this.generatedBytes = 0;
  }

  chunk(delta, finishReason = null, usage) {
    return {
      id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    };
  }

  start(output) {
    if (this.started) return;
    this.started = true;
    output.push(this.chunk({ role: 'assistant', content: '' }));
  }

  addBytes(value) {
    this.generatedBytes += Buffer.byteLength(value);
    if (this.generatedBytes > 64 * 1024 * 1024) upstreamBad('Upstream response exceeded 64 MiB.', 'response_too_large');
  }

  itemFor(event, type) {
    const index = event.output_index ?? this.ids.get(event.item_id);
    if (!Number.isInteger(index) || index < 0) upstreamBad('Upstream event has no valid output_index.');
    let item = this.items.get(index);
    if (!item) {
      item = { type, index, parts: new Map(), arguments: '', announced: false };
      this.items.set(index, item);
    }
    if (type && item.type && type !== item.type) upstreamBad('Upstream output item changed its type.');
    item.type ||= type;
    return item;
  }

  announceTool(item, output) {
    if (item.announced) return;
    if (!item.call_id || !item.name) return;
    item.announced = true;
    item.toolIndex = this.toolCount++;
    output.push(this.chunk({ tool_calls: [{ index: item.toolIndex, id: item.call_id, type: 'function', function: { name: this.toolNames.get(item.name) ?? item.name, arguments: '' } }] }));
    if (item.arguments) output.push(this.chunk({ tool_calls: [{ index: item.toolIndex, function: { arguments: item.arguments } }] }));
  }

  appendArguments(item, delta, output) {
    if (typeof delta !== 'string') upstreamBad('Function argument delta must be a string.');
    this.addBytes(delta);
    item.arguments += delta;
    if (item.announced && delta) output.push(this.chunk({ tool_calls: [{ index: item.toolIndex, function: { arguments: delta } }] }));
  }

  finishArguments(item, value, output) {
    if (typeof value !== 'string') upstreamBad('Function arguments are missing.');
    if (!value.startsWith(item.arguments)) upstreamBad('Function argument completion differs from the streamed prefix.');
    this.appendArguments(item, value.slice(item.arguments.length), output);
  }

  appendPart(item, contentIndex, kind, value, output, complete = false) {
    if (!Number.isInteger(contentIndex) || contentIndex < 0 || typeof value !== 'string') upstreamBad('Invalid text/refusal event.');
    const part = item.parts.get(contentIndex) ?? { kind, value: '' };
    if (part.kind !== kind) upstreamBad('Upstream content part changed its type.');
    let delta = value;
    if (complete) {
      if (!value.startsWith(part.value)) upstreamBad('Completed text differs from the streamed prefix.');
      delta = value.slice(part.value.length);
    }
    part.value += delta;
    item.parts.set(contentIndex, part);
    this.addBytes(delta);
    if (delta) output.push(this.chunk({ [kind === 'refusal' ? 'refusal' : 'content']: delta }));
  }

  reconcileItem(raw, outputIndex, output, complete) {
    if (!isObject(raw) || !['reasoning', 'message', 'function_call'].includes(raw.type)) upstreamBad(`Unsupported upstream output type: ${String(raw?.type)}.`);
    const item = this.itemFor({ output_index: outputIndex }, raw.type);
    if (raw.id) this.ids.set(raw.id, outputIndex);
    if (raw.type === 'function_call') {
      for (const key of ['call_id', 'name']) {
        if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !raw[key])) upstreamBad(`Invalid function ${key}.`);
        if (item[key] && raw[key] && item[key] !== raw[key]) upstreamBad(`Function ${key} changed during streaming.`);
        item[key] ||= raw[key];
      }
      this.announceTool(item, output);
      if (complete && typeof raw.arguments !== 'string') upstreamBad('Completed function call is missing arguments.');
      if (typeof raw.arguments === 'string' && (complete || raw.arguments.length)) this.finishArguments(item, raw.arguments, output);
      if (complete) {
        if (!item.call_id || !item.name) upstreamBad('Function call is missing its id or name.');
        parseArguments(item.arguments, 'Upstream function arguments', true);
      }
    } else if (raw.type === 'message') {
      if (raw.role && raw.role !== 'assistant') upstreamBad('Upstream message is not an assistant message.');
      if (!Array.isArray(raw.content)) upstreamBad('Upstream message content must be an array.');
      if (complete && [...item.parts.keys()].some(index => index >= raw.content.length)) upstreamBad('Completed message omitted streamed content.');
      for (const [contentIndex, part] of (raw.content ?? []).entries()) {
        if (part.type === 'output_text') this.appendPart(item, contentIndex, 'text', part.text, output, true);
        else if (part.type === 'refusal') this.appendPart(item, contentIndex, 'refusal', part.refusal, output, true);
        else upstreamBad(`Unsupported upstream message content: ${String(part.type)}.`);
      }
    }
  }

  accept(event) {
    if (!isObject(event) || typeof event.type !== 'string') upstreamBad('Invalid SSE event object.');
    if (this.completed) upstreamBad('Received an event after response.completed.');
    const output = [];
    if (event.type === 'error' || event.type === 'response.failed') {
      const error = event.error ?? event.response?.error ?? event;
      upstreamBad(typeof error.message === 'string' ? error.message.slice(0, 2000) : 'Codex inference failed.', 'upstream_failed');
    }
    if (event.type === 'response.incomplete') upstreamBad(`Codex response was incomplete (${event.response?.incomplete_details?.reason ?? 'unknown reason'}).`, 'upstream_incomplete');
    if (event.response?.id && !this.started) this.id = event.response.id;
    if (event.response?.created_at && !this.started) this.created = event.response.created_at;
    if (!this.model && event.response?.model) this.model = event.response.model;
    this.start(output);
    switch (event.type) {
      case 'response.output_item.added':
        this.reconcileItem(event.item, event.output_index, output, false);
        break;
      case 'response.output_item.done':
        this.reconcileItem(event.item, event.output_index, output, true);
        break;
      case 'response.output_text.delta':
        this.appendPart(this.itemFor(event, 'message'), event.content_index ?? 0, 'text', event.delta, output);
        break;
      case 'response.output_text.done':
        this.appendPart(this.itemFor(event, 'message'), event.content_index ?? 0, 'text', event.text, output, true);
        break;
      case 'response.refusal.delta':
        this.appendPart(this.itemFor(event, 'message'), event.content_index ?? 0, 'refusal', event.delta, output);
        break;
      case 'response.refusal.done':
        this.appendPart(this.itemFor(event, 'message'), event.content_index ?? 0, 'refusal', event.refusal, output, true);
        break;
      case 'response.function_call_arguments.delta':
        this.appendArguments(this.itemFor(event, 'function_call'), event.delta, output);
        break;
      case 'response.function_call_arguments.done':
        this.finishArguments(this.itemFor(event, 'function_call'), event.arguments, output);
        break;
      case 'response.completed': {
        const response = event.response;
        if (!isObject(response) || (response.status && response.status !== 'completed') || !Array.isArray(response.output)) upstreamBad('response.completed did not contain a completed response.');
        for (const [index, raw] of response.output.entries()) this.reconcileItem(raw, index, output, true);
        if (this.items.size > response.output.length) upstreamBad('Final response omitted streamed output items.');
        const callIds = new Set();
        for (const item of this.items.values()) {
          if (item.type !== 'function_call') continue;
          if (!item.announced || callIds.has(item.call_id)) upstreamBad('Invalid or duplicate upstream function call.');
          callIds.add(item.call_id);
          parseArguments(item.arguments, 'Upstream function arguments', true);
        }
        this.completed = true;
        this.usage = normalizeUsage(response.usage);
        this.reasoningCache?.remember(response, this.cacheModel ?? response.model);
        output.push(this.chunk({}, this.toolCount ? 'tool_calls' : 'stop'));
        if (this.includeUsage) output.push(this.chunk({}, null, this.usage));
        break;
      }
      // Lifecycle events, encrypted reasoning, and reasoning summaries are not
      // assistant answer text. Ignoring them avoids leaking internal reasoning.
      default:
        break;
    }
    return output;
  }
}

export async function* translateEvents(events, options = {}) {
  const translator = new EventTranslator(options);
  for await (const event of events) {
    for (const chunk of translator.accept(event)) yield chunk;
    if (translator.completed) return;
  }
  upstreamBad('Codex stream ended before response.completed.', 'upstream_disconnected');
}

export async function collectResponse(events, options = {}) {
  const message = { role: 'assistant', content: '' };
  const calls = new Map();
  let result;
  for await (const chunk of translateEvents(events, { ...options, includeUsage: true })) {
    result ??= { id: chunk.id, object: 'chat.completion', created: chunk.created, model: chunk.model, choices: [] };
    if (chunk.usage) result.usage = chunk.usage;
    for (const choice of chunk.choices) {
      const delta = choice.delta;
      if (typeof delta.content === 'string') message.content += delta.content;
      if (typeof delta.refusal === 'string') message.refusal = (message.refusal ?? '') + delta.refusal;
      for (const call of delta.tool_calls ?? []) {
        const entry = calls.get(call.index) ?? { id: call.id, type: 'function', function: { name: '', arguments: '' } };
        if (call.id) entry.id = call.id;
        if (call.function?.name) entry.function.name += call.function.name;
        if (call.function?.arguments) entry.function.arguments += call.function.arguments;
        calls.set(call.index, entry);
      }
      if (choice.finish_reason) result.choices = [{ index: 0, message, finish_reason: choice.finish_reason }];
    }
  }
  if (calls.size) {
    message.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
    if (!message.content) message.content = null;
  }
  return result;
}
