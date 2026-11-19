// Live verification consumes Codex quota. It checks echoed settings, not answer quality.
import assert from 'node:assert/strict';
import {loadConfig, ensureLocalKey} from './src/config.mjs';

const config = loadConfig();
const requestedId = process.argv[2];
const route = requestedId ? config.models.find(item => item.id === requestedId) : config.models[0];
if (!route) { console.error('Unknown model ID.'); process.exit(1); }
const efforts = route.reasoning?.supportedEfforts;
if (!efforts?.length) { console.error('Set reasoning.supportedEfforts in the model configuration first.'); process.exit(1); }
const key = ensureLocalKey();
let failures = 0;
for (const effort of efforts) {
  const started = Date.now();
  try {
    const response = await fetch(`http://${config.host}:${config.port}/v1/chat/completions`, {
      method: 'POST', headers: {authorization: `Bearer ${key}`, 'content-type': 'application/json'},
      body: JSON.stringify({model: route.id, reasoning_effort: effort, messages: [
        {role: 'user', content: 'Find the smallest positive integer n such that n mod 7 = 4, n mod 9 = 5, and n mod 11 = 6. Reply only the integer.'},
      ]}), signal: AbortSignal.timeout(config.requestTimeoutMs + 5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${result.error?.message || 'Request failed'}`);
    const forwarded = response.headers.get('x-codex-reasoning-effort');
    const returned = response.headers.get('x-codex-upstream-reasoning-effort');
    assert.equal(forwarded, effort, 'Gateway did not forward the selected effort');
    assert.equal(returned, effort, 'Upstream did not confirm the selected effort');
    assert.equal(result.choices?.[0]?.finish_reason, 'stop');
    assert.equal(result.choices?.[0]?.message?.content?.trim(), '347');
    const reasoningTokens = result.usage?.completion_tokens_details?.reasoning_tokens;
    assert.equal(typeof reasoningTokens, 'number', 'Upstream did not report reasoning token usage');
    console.log(JSON.stringify({status: 'PASS', model: route.id, requested: effort, forwarded, returned, reasoningTokens, durationMs: Date.now() - started}));
  } catch (error) {
    failures++;
    console.error(JSON.stringify({status: 'FAIL', model: route.id, effort, error: String(error.message).split(key).join('[REDACTED]')}));
  }
}
console.log('Echoed effort confirms the requested setting; token counts vary by task and do not prove a quality ranking.');
if (failures) process.exitCode = 1;
