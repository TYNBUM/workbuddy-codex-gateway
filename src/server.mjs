import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { loadConfig, ensureLocalKey, UPSTREAM_URL } from './config.mjs';
import { createAuthProvider } from './auth.mjs';
import { parseSSE } from './sse.mjs';
import { toResponses, translateEvents, collectResponse, ReasoningCache } from './protocol.mjs';

const SERVICE = 'workbuddy-codex-gateway';
function problem(status, message, code) { return Object.assign(new Error(message), { status, code }); }
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
function authorized(req, key) {
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${key}`);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}
function readBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(problem(499, 'Request cancelled.', 'request_cancelled'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    const cleanup = () => signal.removeEventListener('abort', abort);
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (!tooLarge) { tooLarge = true; chunks.length = 0; reject(problem(413, 'Request body exceeds the gateway limit.', 'body_too_large')); }
      } else if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', () => {
      cleanup();
      if (tooLarge) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(problem(400, 'Request body must be valid JSON.', 'invalid_json')); }
    });
    req.on('error', (error) => { cleanup(); reject(error); });
    req.on('aborted', () => { cleanup(); reject(problem(499, 'Client disconnected.', 'client_disconnected')); });
  });
}
async function write(res, content, signal) {
  signal.throwIfAborted();
  if (res.destroyed) throw problem(499, 'Client disconnected.', 'client_disconnected');
  if (!res.write(content)) await once(res, 'drain', { signal });
}

export async function startServer(config, dependencies = {}) {
  const key = dependencies.key || ensureLocalKey();
  const getAuth = dependencies.getAuth || createAuthProvider(config);
  const fetchUpstream = dependencies.fetch || fetch;
  const reasoningCache = new ReasoningCache();
  const stats = { active: 0, completed: 0, failed: 0, lastCompletion: null };
  const controllers = new Set();
  const server = http.createServer(async (req, res) => {
    let route;
    try { route = new URL(req.url, 'http://127.0.0.1').pathname.replace(/\/+$/, '') || '/'; }
    catch { return json(res, 400, { error: { message: 'Invalid request URL.', code: 'invalid_url' } }); }
    if (req.method === 'GET' && route === '/health') return json(res, 200, { service: SERVICE, version: '1.0.0', pid: process.pid, ...stats });
    if (!authorized(req, key)) return json(res, 401, { error: { message: 'Invalid local gateway key.', type: 'authentication_error', code: 'invalid_local_key' } });
    if (req.method === 'GET' && route === '/v1/models') return json(res, 200, { object: 'list', data: config.models.map((model) => ({ id: model.id, object: 'model', created: 0, owned_by: 'local-codex-gateway' })) });
    if (req.method === 'POST' && route === '/admin/shutdown') {
      json(res, 200, { stopping: true });
      setImmediate(() => { for (const controller of controllers) controller.abort(); server.close(); server.closeAllConnections(); });
      return;
    }
    if (req.method !== 'POST' || !['/v1/chat/completions', '/chat/completions'].includes(route)) return json(res, 404, { error: { message: 'Unknown endpoint.', code: 'not_found' } });
    if (stats.active >= config.maxConcurrentRequests) {
      res.setHeader('retry-after', '3');
      return json(res, 429, { error: { message: 'Gateway is busy; retry shortly.', code: 'gateway_busy' } });
    }
    stats.active++;
    const requestId = crypto.randomUUID();
    const controller = new AbortController(); controllers.add(controller);
    let timedOut = false, ping, secret = '', selectedModel = '';
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.requestTimeoutMs);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', disconnect);
    req.on('aborted', disconnect);
    try {
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw problem(415, 'Use Content-Type: application/json.', 'unsupported_media_type');
      const body = await readBody(req, config.maxBodyBytes, controller.signal);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'JSON body must be an object.', 'invalid_request');
      const model = config.models.find((item) => item.id === body.model);
      if (!model) throw problem(400, 'Unknown model; use an ID from /v1/models.', 'model_not_found');
      selectedModel = model.upstream;
      const { payload, toolNames } = toResponses(body, { model: model.upstream, effort: model.reasoning?.defaultEffort || model.effort || config.defaultEffort, reasoningCache });
      const effectiveEffort = payload.reasoning?.effort;
      if (model.reasoning?.supportedEfforts && !model.reasoning.supportedEfforts.includes(effectiveEffort)) {
        throw problem(400, `Unsupported reasoning effort for this route. Choose: ${model.reasoning.supportedEfforts.join(', ')}.`, 'unsupported_reasoning_effort');
      }
      res.setHeader('x-codex-request-id', requestId);
      if (effectiveEffort) res.setHeader('x-codex-reasoning-effort', effectiveEffort);
      let upstream;
      for (let attempt = 0; attempt < 2; attempt++) {
        const auth = await getAuth(attempt === 1);
        secret = auth.accessToken;
        controller.signal.throwIfAborted();
        upstream = await fetchUpstream(UPSTREAM_URL, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            authorization: `Bearer ${auth.accessToken}`, 'ChatGPT-Account-ID': auth.accountId,
            'content-type': 'application/json', accept: 'text/event-stream',
            originator: 'codex_cli_rs', 'user-agent': 'workbuddy-codex-gateway/1.0.0',
            'x-client-request-id': requestId,
          }, body: JSON.stringify(payload),
        });
        if (upstream.status !== 401 || attempt === 1) break;
        await upstream.body?.cancel();
      }
      if (!upstream.ok) {
        const retry = upstream.headers.get('retry-after');
        if (retry) res.setHeader('retry-after', retry);
        let message = `Codex upstream returned HTTP ${upstream.status}.`;
        try { const detail = await upstream.json(); message = detail.error?.message || detail.detail || message; } catch {}
        throw problem(upstream.status, String(message), `upstream_${upstream.status}`);
      }
      // The Codex backend can omit Content-Type while returning valid SSE.
      // The parser and terminal-event checks still validate the actual body.
      const contentType = upstream.headers.get('content-type');
      if (contentType && !contentType.toLowerCase().includes('text/event-stream')) { await upstream.body?.cancel(); throw problem(502, 'Codex upstream did not return an SSE stream.', 'invalid_upstream_content_type'); }
      let upstreamEffort = null, reasoningTokens = null;
      async function* observedEvents() {
        for await (const event of parseSSE(upstream.body)) {
          if (event.type === 'response.completed') {
            upstreamEffort = event.response?.reasoning?.effort ?? null;
            reasoningTokens = event.response?.usage?.output_tokens_details?.reasoning_tokens ?? null;
          }
          yield event;
        }
      }
      const events = observedEvents();
      const options = { model: model.id, cacheModel: model.upstream, reasoningCache, toolNames, includeUsage: body.stream_options?.include_usage === true };
      let toolCalls = false;
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.flushHeaders();
        ping = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': keep-alive\n\n'); }, 10000);
        for await (const chunk of translateEvents(events, options)) {
          toolCalls ||= Boolean(chunk.choices?.some((choice) => choice.delta?.tool_calls?.length));
          await write(res, `data: ${JSON.stringify(chunk)}\n\n`, controller.signal);
        }
        await write(res, 'data: [DONE]\n\n', controller.signal);
        res.end();
      } else {
        const completion = await collectResponse(events, options);
        toolCalls = Boolean(completion.choices?.[0]?.message?.tool_calls?.length);
        if (upstreamEffort) res.setHeader('x-codex-upstream-reasoning-effort', upstreamEffort);
        json(res, 200, completion);
      }
      stats.completed++;
      stats.lastCompletion = { at: new Date().toISOString(), requestId, model: model.id, upstream: model.upstream, toolCalls,
        requestedEffort: body.reasoning_effort ?? body.reasoning?.effort ?? null,
        effectiveEffort, upstreamEffort, reasoningTokens };
    } catch (error) {
      stats.failed++;
      const status = timedOut ? 504 : (error.status || error.statusCode || 502);
      let message = timedOut ? 'Codex request timed out.' : error.message || 'Gateway request failed.';
      for (const sensitive of [secret, key]) if (sensitive) message = message.split(sensitive).join('[REDACTED]');
      message = message.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]').replace(/\beyJ[A-Za-z0-9_.-]{40,}/g, '[REDACTED]');
      const value = { error: { message: message.slice(0, 2000), type: error.type || 'gateway_error', code: timedOut ? 'upstream_timeout' : error.code || 'upstream_error' } };
      if (!res.destroyed && !res.writableEnded) {
        if (res.headersSent) res.end(`data: ${JSON.stringify(value)}\n\n`);
        else json(res, status >= 400 && status <= 599 ? status : 502, value);
      }
      if (!dependencies.quiet) console.error(JSON.stringify({ at: new Date().toISOString(), requestId, model: selectedModel, status, code: value.error.code }));
    } finally {
      controller.abort(); clearTimeout(timer); clearInterval(ping);
      controllers.delete(controller); stats.active--;
      res.off('close', disconnect); req.off('aborted', disconnect);
    }
  });
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = await startServer(loadConfig());
    console.log(JSON.stringify({ service: SERVICE, event: 'listening', ...server.address() }));
    const stop = () => { server.close(); server.closeAllConnections(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
