import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

export class AuthError extends Error {
  constructor(message) { super(message); this.status = 503; this.code = 'codex_login_required'; }
}

// Only Codex itself may update its credential store. The gateway never writes it.
export function readCodexAuth(file) {
  let auth;
  try { auth = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch { throw new AuthError('Cannot read Codex login. Sign in with ChatGPT in Codex, then retry.'); }
  if (auth.auth_mode !== 'chatgpt' || !auth.tokens?.access_token) {
    throw new AuthError('Codex must be signed in with ChatGPT; API-key mode is not used by this gateway.');
  }
  let claims = {};
  try { claims = JSON.parse(Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url').toString()); } catch {}
  const accountId = auth.tokens.account_id || claims['https://api.openai.com/auth']?.chatgpt_account_id;
  if (!accountId) throw new AuthError('Codex login has no account ID. Sign in again.');
  return { accessToken: auth.tokens.access_token, accountId, expiresAt: claims.exp || 0 };
}

export function refreshWithCodex(config) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.codexCommand, ['app-server', '--listen', 'stdio://', '-c', 'model_provider="openai"'], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: path.dirname(config.codexAuthFile) },
    });
    const lines = readline.createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close(); child.stdin.end(); child.kill();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new AuthError('Codex login refresh timed out. Open Codex and sign in again.')), 45000);
    // Drain without logging: app-server diagnostics may contain account information.
    child.stderr.resume();
    child.on('error', () => finish(new AuthError('Cannot launch Codex CLI. Install it or set codexCommand in gateway.config.json.')));
    child.stdin.on('error', () => finish(new AuthError('Codex login helper closed unexpectedly.')));
    child.on('exit', () => { if (!settled) finish(new AuthError('Codex login helper exited before refreshing credentials.')); });
    const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
    lines.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) {
        if (message.error) return finish(new AuthError('Codex initialization failed. Update or sign in to Codex.'));
        send({ method: 'initialized', params: {} });
        send({ id: 2, method: 'account/read', params: { refreshToken: true } });
      } else if (message.id === 2) {
        if (message.error || message.result?.account?.type !== 'chatgpt') return finish(new AuthError('Codex could not refresh the ChatGPT login. Sign in to Codex again.'));
        finish();
      } else if (message.id !== undefined && message.method) {
        send({ id: message.id, error: { code: -32601, message: 'Gateway only supports managed Codex authentication.' } });
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'workbuddy_codex_gateway', title: 'WorkBuddy Codex Gateway', version: '1.0.0' } } });
  });
}

export function createAuthProvider(config, refresh = refreshWithCodex) {
  let refreshing;
  return async function getAuth(forceRefresh = false) {
    let auth = readCodexAuth(config.codexAuthFile);
    if (forceRefresh || (auth.expiresAt && auth.expiresAt * 1000 < Date.now() + 120000)) {
      refreshing ||= refresh(config).finally(() => { refreshing = undefined; });
      await refreshing;
      auth = readCodexAuth(config.codexAuthFile);
    }
    return auth;
  };
}
