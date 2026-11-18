import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const stateDir = process.env.WB_CODEX_STATE_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'state'), 'WorkBuddyCodexGateway');
export const UPSTREAM_URL = 'https://chatgpt.com/backend-api/codex/responses';

export function findCodexCommand() {
  if (process.platform === 'win32') {
    const npm = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex');
    if (npm) {
      for (const arch of ['x64', 'arm64']) {
        const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
        const candidate = path.join(npm, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
    return 'codex.exe';
  }
  return 'codex';
}

export function loadConfig({ file = process.env.WB_CODEX_CONFIG || path.join(rootDir, 'gateway.config.json') } = {}) {
  if (!fs.existsSync(file)) {
    const template = path.join(rootDir, 'gateway.config.example.json');
    try { fs.copyFileSync(template, file, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error(`Cannot create gateway configuration at ${file}. Copy gateway.config.example.json there manually.`); }
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const config = {
    host: '127.0.0.1', port: 18789, defaultEffort: 'medium',
    requestTimeoutMs: 300000, maxBodyBytes: 32 * 1024 * 1024, maxConcurrentRequests: 4,
    networkProxy: null, ...raw,
    codexAuthFile: raw.codexAuthFile || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json'),
    codexCommand: raw.codexCommand || findCodexCommand(),
  };
  if (config.host !== '127.0.0.1') throw new Error('Only the loopback host 127.0.0.1 is supported.');
  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid gateway port.');
  for (const key of ['requestTimeoutMs', 'maxBodyBytes', 'maxConcurrentRequests']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}.`);
  }
  if (!Array.isArray(config.models) || !config.models.length) throw new Error('Configure at least one model.');
  const ids = new Set();
  for (const model of config.models) {
    if (!model || ['id', 'name', 'upstream'].some((key) => typeof model[key] !== 'string' || !model[key].trim()) || ids.has(model.id)) throw new Error('Invalid or duplicate model entry.');
    if (model.upstream.startsWith('REPLACE_WITH_')) throw new Error(`配置模板已准备好：${file}。请先将 models[].upstream 改为你的 Codex 账号可用的模型名称，再重新运行。`);
    ids.add(model.id);
  }
  if (config.networkProxy && !['http:', 'https:'].includes(new URL(config.networkProxy).protocol)) throw new Error('Invalid networkProxy protocol.');
  return config;
}

export function ensureLocalKey() {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, 'local-key');
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid local-key file; restore the local gateway key.');
  return key;
}
