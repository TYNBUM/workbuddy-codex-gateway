#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureLocalKey, rootDir, stateDir } from './src/config.mjs';

const SERVICE = 'workbuddy-codex-gateway';
const DEFAULT_CONFIG = join(homedir(), '.workbuddy', 'models.json');
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const stable = (value) => JSON.stringify(value);
const fingerprint = (text) => createHash('sha256').update(text).digest('hex');

function parseJson(text, label) {
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`${label} 不是有效 JSON；未修改文件。`); }
}

function readDocument(targetPath) {
  const original = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  const document = original === null ? [] : parseJson(original, targetPath);
  const models = Array.isArray(document) ? document : document?.models;
  if (!Array.isArray(models)) throw new Error('models.json 的结构无法识别；仅支持模型数组或包含 models 数组的对象，未修改文件。');
  if (models.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry))) {
    throw new Error('models.json 包含无效模型条目，未修改文件。');
  }
  return { original, document, models };
}

function timestamp() { return new Date().toISOString().replaceAll(':', '-'); }

function writeDocument(targetPath, read, models) {
  const current = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
  if (current !== read.original) throw new Error('WorkBuddy 配置刚被其他程序修改，请重试；本次未覆盖。');
  const document = Array.isArray(read.document) ? models : { ...read.document, models };
  const content = `${JSON.stringify(document, null, 2)}\n`;
  if (content === current) return { changed: false, backupPath: null };
  mkdirSync(dirname(targetPath), { recursive: true });
  const backupPath = current === null ? null : `${targetPath}.workbuddy-codex-${timestamp()}-${process.pid}-${randomUUID().slice(0, 8)}.bak`;
  if (backupPath) copyFileSync(targetPath, backupPath);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const latest = existsSync(targetPath) ? readFileSync(targetPath, 'utf8') : null;
    if (latest !== read.original) throw new Error('写入前检测到配置变化；已保留现有配置，请重试。');
    renameSync(temporaryPath, targetPath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
  return { changed: true, backupPath };
}

function journalPathFor(targetPath, directory) {
  return join(directory, `config-history-${fingerprint(resolve(targetPath)).slice(0, 16)}.json`);
}

function loadJournal(targetPath, directory) {
  const path = journalPathFor(targetPath, directory);
  if (!existsSync(path)) return { path, entries: [] };
  const journal = parseJson(readFileSync(path, 'utf8'), '配置变更记录');
  if (journal.targetPath !== resolve(targetPath) || !Array.isArray(journal.entries)) {
    throw new Error('配置变更记录与当前目标不匹配；未修改文件。');
  }
  return { path, entries: journal.entries };
}

function saveJournal(journal, targetPath, directory) {
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${journal.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify({ targetPath: resolve(targetPath), entries: journal.entries }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, journal.path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

export function managedEntries(config, localKey) {
  return config.models.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    vendor: 'Custom',
    url: `http://${config.host}:${config.port}/v1/chat/completions`,
    apiKey: localKey,
    supportsToolCall: true,
    supportsImages: true,
    supportsReasoning: true,
    useCustomProtocol: false,
    ...(model.maxInputTokens ? { maxInputTokens: model.maxInputTokens } : {}),
    ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
  }));
}

export function configureModels({ config, localKey, targetPath = DEFAULT_CONFIG, stateDirectory = stateDir }) {
  const read = readDocument(targetPath);
  const requested = managedEntries(config, localKey);
  const journal = loadJournal(targetPath, stateDirectory);
  const changes = [];
  const next = [...read.models];
  for (const desired of requested) {
    const matches = next.filter((entry) => entry.id === desired.id);
    if (matches.length > 1) throw new Error(`模型 ${desired.id} 存在重复条目，请先在 WorkBuddy 中处理；未修改文件。`);
    if (matches.length && matches[0].url !== desired.url) {
      throw new Error(`模型 ${desired.id} 已存在且指向其他地址；为保留原配置，本次未修改。请在 gateway 配置中换一个 id。`);
    }
    const existing = matches[0] ?? null;
    const after = { ...(existing ?? {}), ...desired };
    if (existing && stable(existing) === stable(after)) continue;
    changes.push({ id: desired.id, before: existing, after });
    const index = next.findIndex((entry) => entry.id === desired.id);
    if (index === -1) next.push(after); else next[index] = after;
  }
  if (!changes.length) return { changed: false, count: requested.length, backupPath: null };
  // Save the recovery record first. If the write fails, restore-config skips entries
  // that do not exactly match the expected post-write value.
  journal.entries.push({ at: new Date().toISOString(), operation: 'configure', changes });
  saveJournal(journal, targetPath, stateDirectory);
  const result = writeDocument(targetPath, read, next);
  return { ...result, count: requested.length };
}

export function removeModels({ config, targetPath = DEFAULT_CONFIG, stateDirectory = stateDir }) {
  if (!existsSync(targetPath)) return { changed: false, count: 0, backupPath: null };
  const read = readDocument(targetPath);
  const identities = managedEntries(config, '');
  const owned = (entry) => identities.some((identity) => identity.id === entry.id && identity.url === entry.url);
  const removed = read.models.filter(owned);
  if (!removed.length) return { changed: false, count: 0, backupPath: null };
  const journal = loadJournal(targetPath, stateDirectory);
  journal.entries.push({ at: new Date().toISOString(), operation: 'remove-config', changes: removed.map((entry) => ({ id: entry.id, before: entry, after: null })) });
  saveJournal(journal, targetPath, stateDirectory);
  const result = writeDocument(targetPath, read, read.models.filter((entry) => !owned(entry)));
  return { ...result, count: removed.length };
}

export function restoreModels({ targetPath = DEFAULT_CONFIG, stateDirectory = stateDir }) {
  const journal = loadJournal(targetPath, stateDirectory);
  const transaction = journal.entries.findLast((entry) => !entry.restoredAt);
  if (!transaction) return { changed: false, count: 0, skipped: [], backupPath: null };
  const read = readDocument(targetPath);
  const next = [...read.models];
  const skipped = [];
  let count = 0;
  for (const change of transaction.changes) {
    const matches = next.filter((entry) => entry.id === change.id);
    const current = matches[0] ?? null;
    if (matches.length > 1 || stable(current) !== stable(change.after)) { skipped.push(change.id); continue; }
    const index = next.findIndex((entry) => entry.id === change.id);
    if (change.before === null && index !== -1) next.splice(index, 1);
    else if (change.before !== null && index === -1) next.push(change.before);
    else if (change.before !== null) next[index] = change.before;
    count++;
  }
  const result = count ? writeDocument(targetPath, read, next) : { changed: false, backupPath: null };
  transaction.restoredAt = new Date().toISOString();
  transaction.skipped = skipped;
  saveJournal(journal, targetPath, stateDirectory);
  return { ...result, count, skipped };
}

async function health(config, timeout = 1500) {
  try {
    const response = await fetch(`http://${config.host}:${config.port}/health`, { signal: AbortSignal.timeout(timeout) });
    let data;
    try { data = await response.json(); } catch { data = null; }
    return { reachable: true, own: response.ok && data?.service === SERVICE, status: response.status, data };
  } catch { return { reachable: false, own: false }; }
}

async function portOpen(config) {
  return new Promise((done) => {
    const socket = createConnection({ host: config.host, port: config.port });
    const finish = (open) => { socket.destroy(); done(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function start(config) {
  const current = await health(config);
  if (current.own) { console.log(`网关已运行：127.0.0.1:${config.port}（PID ${current.data.pid ?? '未知'}）`); return; }
  if (current.reachable || await portOpen(config)) throw new Error(`端口 ${config.port} 已被其他服务占用，未启动新进程。`);
  await ensureLocalKey();
  mkdirSync(stateDir, { recursive: true });
  const stdoutPath = join(stateDir, 'gateway.stdout.log');
  const stderrPath = join(stateDir, 'gateway.stderr.log');
  const stdout = openSync(stdoutPath, 'a', 0o600);
  const stderr = openSync(stderrPath, 'a', 0o600);
  const environment = { ...process.env, NODE_USE_ENV_PROXY: '1' };
  if (config.networkProxy) {
    environment.HTTP_PROXY = config.networkProxy;
    environment.HTTPS_PROXY = config.networkProxy;
  }
  const noProxy = environment.NO_PROXY || environment.no_proxy || '';
  environment.NO_PROXY = `${noProxy}${noProxy ? ',' : ''}127.0.0.1,localhost,::1`;
  let child;
  let launchError;
  try {
    child = spawn(process.execPath, [join(rootDir, 'src', 'server.mjs')], {
      cwd: rootDir, env: environment, detached: true, windowsHide: true,
      stdio: ['ignore', stdout, stderr],
    });
    child.once('error', (error) => { launchError = error; });
    child.unref();
  } finally { closeSync(stdout); closeSync(stderr); }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (launchError) throw new Error(`Node 进程启动失败（${launchError.code ?? '未知错误'}）。`);
    const result = await health(config, 800);
    if (result.own) {
      console.log(`网关已启动：http://127.0.0.1:${config.port}/v1`);
      console.log(`运行日志：${stateDir}`);
      return;
    }
    if (child.exitCode !== null && child.exitCode !== undefined) break;
    await delay(250);
  }
  throw new Error(`网关未在 10 秒内就绪，请查看 ${stderrPath}。`);
}

async function stop(config) {
  const current = await health(config);
  if (!current.reachable) { console.log('网关当前未运行。'); return; }
  if (!current.own) throw new Error(`端口 ${config.port} 并非本项目网关；未停止任何进程。`);
  const key = await ensureLocalKey();
  const response = await fetch(`http://${config.host}:${config.port}/admin/shutdown`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`停止请求失败（HTTP ${response.status}）；未强制结束任何进程。`);
  await response.arrayBuffer();
  for (let attempt = 0; attempt < 20; attempt++) {
    await delay(200);
    const result = await health(config, 500);
    if (!result.own) { console.log('网关已停止。'); return; }
  }
  throw new Error('网关仍在退出中，请稍后运行 status；未强制结束进程。');
}

async function status(config) {
  const current = await health(config);
  if (current.own) {
    console.log(`运行中：127.0.0.1:${config.port}；PID ${current.data.pid ?? '未知'}；版本 ${current.data.version ?? '未知'}`);
  } else if (current.reachable) {
    console.log(`端口 ${config.port} 是其他 HTTP 服务，未识别为本项目网关。`);
    process.exitCode = 1;
  } else {
    console.log(`网关未运行：127.0.0.1:${config.port}`);
    process.exitCode = 1;
  }
}

async function doctor(config, targetPath) {
  let issues = 0;
  const check = (ok, text) => { console.log(`${ok ? '[OK]' : '[检查]'} ${text}`); if (!ok) issues++; };
  const [major, minor] = process.versions.node.split('.').map(Number);
  check(major > 24 || (major === 24 && minor >= 5), `Node ${process.versions.node}（要求 >=24.5）`);
  check(config.host === '127.0.0.1', `监听地址 ${config.host}:${config.port}`);
  const authPath = config.codexAuthFile;
  if (authPath && existsSync(authPath)) {
    try {
      const auth = parseJson(readFileSync(authPath, 'utf8'), 'Codex 登录文件');
      const mode = auth.auth_mode ?? (auth.tokens ? 'chatgpt' : 'unknown');
      check(mode === 'chatgpt', `Codex 登录模式：${mode === 'chatgpt' ? 'ChatGPT' : mode === 'apikey' ? 'API Key' : '未识别'}（不显示凭据）`);
      check(Boolean(auth.tokens?.access_token), 'Codex ChatGPT 访问凭据' + (auth.tokens?.access_token ? '已存在' : '缺失，请运行 codex login'));
    } catch { check(false, '无法解析 Codex 登录文件，请使用 codex login 重新登录。'); }
  } else check(false, '未找到 Codex 登录文件，请先使用 ChatGPT 账号运行 codex login。');
  check(Boolean(config.models?.length), `网关模型：${config.models.map((model) => model.id).join('、')}`);
  console.log(`上游代理：${config.networkProxy ? '已配置（不显示地址或凭据）' : '按系统进程环境设置'}`);
  const current = await health(config);
  check(current.own, current.own ? '网关健康检查通过' : current.reachable ? '配置端口由其他 HTTP 服务占用' : '网关未运行，请执行 start');
  if (existsSync(targetPath)) {
    try {
      const { models } = readDocument(targetPath);
      const identities = managedEntries(config, '');
      const found = identities.filter((entry) => models.some((model) => model.id === entry.id && model.url === entry.url));
      check(found.length === identities.length, `WorkBuddy 已配置 ${found.length}/${identities.length} 个网关模型`);
      for (const identity of identities) {
        const match = models.find((model) => model.id === identity.id && model.url === identity.url);
        if (match) check(match.supportsToolCall === true, `${identity.id} 的工具调用${match.supportsToolCall ? '已启用' : '未启用'}`);
      }
    } catch { check(false, 'WorkBuddy 模型配置无法解析。'); }
  } else check(false, `WorkBuddy 模型配置不存在：${targetPath}`);
  console.log('doctor 仅做本地诊断，不发送模型推理请求，也不验证实际可用额度。');
  if (issues) process.exitCode = 1;
}

function reportMutation(result, text) {
  console.log(result.changed ? `${text} ${result.count} 个模型。` : '配置无需变更。');
  if (result.backupPath) console.log(`原配置备份：${result.backupPath}`);
  if (result.skipped?.length) console.log(`保留了后续手动修改的条目：${result.skipped.join('、')}`);
}

export async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...args] = argv;
  let targetPath = DEFAULT_CONFIG;
  while (args.length) {
    const argument = args.shift();
    if (argument === '--workbuddy-config' && args.length) targetPath = resolve(args.shift());
    else throw new Error(`不支持的参数：${argument}`);
  }
  if (['help', '--help', '-h'].includes(command)) {
    console.log('WorkBuddy → Codex 本地网关\n\nnode cli.mjs start           隐藏启动网关\nnode cli.mjs stop            安全停止本网关\nnode cli.mjs status          查看运行状态\nnode cli.mjs doctor          本地诊断（不消耗模型额度）\nnode cli.mjs configure       追加 WorkBuddy 模型，自动备份\nnode cli.mjs remove-config   仅移除本项目模型\nnode cli.mjs restore-config  撤销最近一次配置变更，保留后续手动修改\n\n配置命令可附加 --workbuddy-config <models.json 路径>。');
    return;
  }
  const config = await loadConfig();
  if (command === 'start') return start(config);
  if (command === 'stop') return stop(config);
  if (command === 'status') return status(config);
  if (command === 'doctor') return doctor(config, targetPath);
  if (command === 'configure') {
    reportMutation(configureModels({ config, localKey: await ensureLocalKey(), targetPath }), '已配置');
    console.log('回到 WorkBuddy，在会话的模型选择器中明确选择 Codex 条目。若列表未更新，请完全退出后重新打开。');
    return;
  }
  if (command === 'remove-config') return reportMutation(removeModels({ config, targetPath }), '已移除');
  if (command === 'restore-config') return reportMutation(restoreModels({ targetPath }), '已恢复');
  throw new Error(`未知命令：${command}；运行 node cli.mjs help 查看用法。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`错误：${error.message}`); process.exitCode = 1; });
}
