/**
 * dsh-update-center — Host half.
 *
 * Serves the Web UI's update checks over plain HTTP routes:
 *   GET  /dsh-update/status   current vs npm `latest`, plus parsed release highlights
 *   POST /dsh-update/ignore   remember (or clear) an ignored version
 *   POST /dsh-update/apply    spawn the detached update helper (npm install -g + restart)
 *
 * The browser half (client.js) renders the Settings → General row and the
 * bottom-left prompt. This file owns version math, the npm/GitHub lookups, the
 * small durable state file, and the loopback/same-origin fence around writes.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmInvocation } from './npm-invocation.mjs';

const PACKAGE = '@deepseek-ai/dsh';
const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@deepseek-ai/dsh/latest';
const RELEASES_URL =
  'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30';
const RELEASE_TAG_PREFIX = 'dsh-v';
const RELEASE_PAGE_BASE =
  'https://github.com/deepseek-ai/deepseek-harness/releases/tag/';
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_RELEASES = 5;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const MAX_RELEASES = 12;

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_DIR = join(DSH_HOME, 'dsh-update');
const STATE_FILE = join(STATE_DIR, 'state.json');
const LOG_DIR = join(STATE_DIR, 'logs');
const PLAN_DIR = join(STATE_DIR, 'plans');
const LOCK_FILE = join(STATE_DIR, 'update.lock');

/* ------------------------------------------------------------------ *
 * Version math (semver subset: numeric core + prerelease identifiers) *
 * ------------------------------------------------------------------ */

function splitVersion(value) {
  const clean = String(value ?? '')
    .trim()
    .replace(/^v/iu, '')
    .split('+')[0];
  const dash = clean.indexOf('-');
  return dash === -1
    ? { core: clean, pre: '' }
    : { core: clean.slice(0, dash), pre: clean.slice(dash + 1) };
}

function coreNumbers(core) {
  return core.split('.').map((part) => {
    const value = Number(part);
    return Number.isFinite(value) ? value : 0;
  });
}

function compareIdentifier(left, right) {
  const leftNumeric = /^\d+$/u.test(left);
  const rightNumeric = /^\d+$/u.test(right);
  if (leftNumeric && rightNumeric) return Number(left) - Number(right);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Compare two semver-ish version strings; returns negative / zero / positive. */
function compareVersions(left, right) {
  const a = splitVersion(left);
  const b = splitVersion(right);
  const leftCore = coreNumbers(a.core);
  const rightCore = coreNumbers(b.core);
  for (let index = 0; index < 3; index += 1) {
    const diff = (leftCore[index] ?? 0) - (rightCore[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (a.pre === '' && b.pre === '') return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  const leftParts = a.pre.split('.');
  const rightParts = b.pre.split('.');
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    const diff = compareIdentifier(leftParts[index], rightParts[index]);
    if (diff !== 0) return diff;
  }
  return 0;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

/* ------------------------------------- *
 * Durable state (ignored version, last update, cached feed) *
 * ------------------------------------- */

function emptyState() {
  return { ignoredVersion: null, lastUpdate: null, cache: null };
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    return { ...emptyState(), ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch {
    return emptyState();
  }
}

/**
 * Write the state document atomically: the helper writes the same file while
 * the Host reads it, and a half-written JSON would blank the settings row.
 * Temp file + rename is atomic on both NTFS and POSIX for same-directory moves.
 */
function writeState(next) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const temp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, STATE_FILE);
  } catch {
    /* A read-only home must not break the UI; the in-memory answer still works. */
    try {
      rmSync(`${STATE_FILE}.${process.pid}.tmp`, { force: true });
    } catch {
      /* nothing left to clean */
    }
  }
  return next;
}

function patchState(patch) {
  return writeState({ ...readState(), ...patch });
}

/* -------------------------------------- *
 * Installed DSH location and its version *
 * -------------------------------------- */

function dshInstallRoot() {
  const entry = typeof process.argv[1] === 'string' ? process.argv[1] : '';
  const match = /^(.*)[\\/]lib[\\/]bin\.js$/u.exec(entry);
  if (!match) return null;
  const root = resolve(match[1]);
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return manifest && manifest.name === PACKAGE ? root : null;
  } catch {
    return null;
  }
}

function installedVersion() {
  const root = dshInstallRoot();
  if (!root) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function installPrefix(root) {
  if (!root) return null;
  if (!/[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh$/u.test(root)) return null;
  return resolve(root, '..', '..', '..');
}

function servingPort(request) {
  const host = request.headers.host;
  if (typeof host !== 'string') return null;
  const match = /:(\d{1,5})$/u.exec(host);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/* ----------------------- *
 * Release-notes parsing   *
 * ----------------------- */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (whole, code) => {
    const key = code.toLowerCase();
    if (key in ENTITIES) return ENTITIES[key];
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return whole;
  });
}

function stripInline(text) {
  let out = String(text ?? '');
  out = out.replace(/<[^>]+>/gu, '');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/gu, '');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1');
  out = out.replace(/\*\*([^*]+)\*\*/gu, '$1');
  out = out.replace(/__([^_]+)__/gu, '$1');
  out = out.replace(/`([^`]+)`/gu, '$1');
  out = out.replace(/\s+/gu, ' ').trim();
  return decodeEntities(out);
}

/**
 * Turn a GitHub release body into locale-agnostic sections. The DSH release
 * bodies carry a Chinese half and an English half; the Chinese half is used
 * when present because this UI is shipped for a Chinese-language workspace.
 */
function parseReleaseNotes(body) {
  const sections = [];
  let text = String(body ?? '').replace(/\r\n?/gu, '\n');
  if (text.trim() === '') return sections;
  const cnHeading = text.search(/<h3[^>]*\bid="cn-[^"]*"[^>]*>/iu);
  const enHeading = text.search(/<h3[^>]*\bid="en-[^"]*"[^>]*>/iu);
  if (cnHeading !== -1) {
    text = text.slice(cnHeading, enHeading > cnHeading ? enHeading : undefined);
  }
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^Full Changelog:/iu.test(line)) continue;
    if (/^\[(中文|English)\]/u.test(line)) continue;
    let heading = null;
    const htmlHeading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/iu.exec(line);
    if (htmlHeading) heading = stripInline(htmlHeading[1]);
    if (!heading) {
      const markdownHeading = /^#{1,6}\s+(.+)$/u.exec(line);
      if (markdownHeading) heading = stripInline(markdownHeading[1]);
    }
    if (heading) {
      current = { heading, items: [] };
      sections.push(current);
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/u.exec(line);
    if (bullet) {
      const item = stripInline(bullet[1]);
      if (item === '') continue;
      if (!current) {
        current = { heading: '', items: [] };
        sections.push(current);
      }
      current.items.push(item);
      continue;
    }
    const paragraph = stripInline(line);
    if (paragraph === '') continue;
    if (!current) {
      current = { heading: '', items: [] };
      sections.push(current);
    }
    current.items.push(paragraph);
  }
  return sections.filter((section) => section.heading !== '' || section.items.length > 0);
}

function mapRelease(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : '';
  if (!tag.startsWith(RELEASE_TAG_PREFIX)) return null;
  const version = tag.slice(RELEASE_TAG_PREFIX.length).trim();
  if (!VERSION_PATTERN.test(version)) return null;
  return {
    version,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : `v${version}`,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    url:
      typeof raw.html_url === 'string'
        ? raw.html_url
        : `${RELEASE_PAGE_BASE}${RELEASE_TAG_PREFIX}${version}`,
    prerelease: raw.prerelease === true,
    sections: parseReleaseNotes(raw.body),
  };
}

/* ---------------- *
 * Network lookups  *
 * ---------------- */

function describeError(error) {
  if (error instanceof Error) {
    if (error.name === 'AbortError') return '请求超时';
    return error.message;
  }
  return String(error);
}

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-update-center/1.0.0',
        ...headers,
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchLatestVersion() {
  const answer = await fetchJson(REGISTRY_LATEST_URL);
  const version = answer && typeof answer.version === 'string' ? answer.version : null;
  if (!version || !VERSION_PATTERN.test(version)) {
    throw new Error('npm registry answer carried no usable version');
  }
  return version;
}

async function fetchReleases() {
  const answer = await fetchJson(RELEASES_URL, {
    accept: 'application/vnd.github+json',
  });
  if (!Array.isArray(answer)) throw new Error('GitHub releases answer was not a list');
  const releases = answer.map(mapRelease).filter(Boolean);
  releases.sort((left, right) => compareVersions(right.version, left.version));
  return releases.slice(0, MAX_RELEASES);
}

/* ---------------- *
 * Update lock      *
 * ---------------- */

/**
 * The update lock lives beside state.json and is created exclusively by the
 * detached helper (index.js only reads it). Two concurrent `npm install -g`
 * runs deleted the global tree on 2026-11-05, so a live lock means every new
 * apply request is refused until that helper exits.
 */
function readUpdateLock() {
  try {
    const parsed = JSON.parse(readFileSync(LOCK_FILE, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function activeUpdate() {
  const lock = readUpdateLock();
  if (lock === null) return null;
  const age = Date.now() - Number(lock.at ?? 0);
  const stale = !(age < 45 * 60 * 1000) || !processAlive(lock.pid);
  return stale ? null : lock;
}

/**
 * A staged tree recorded by stage-helper, only when its lib/bin.js is still on
 * disk. `null` means "nothing ready to switch to".
 */
function preparedUpdate() {
  const state = readState();
  const staged = state.staged && typeof state.staged === 'object' ? state.staged : null;
  if (staged === null) return null;
  if (typeof staged.version !== 'string' || typeof staged.dir !== 'string') return null;
  const bin = join(staged.dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  if (!existsSync(bin)) return null;
  return staged;
}

/* ---------------- *
 * Status assembly  *
 * ---------------- */

function syntheticRelease(version) {
  return {
    version,
    name: `v${version}`,
    publishedAt: null,
    url: `${RELEASE_PAGE_BASE}${RELEASE_TAG_PREFIX}${version}`,
    prerelease: version.includes('-'),
    sections: [],
  };
}

async function buildStatus(force) {
  const current = installedVersion();
  const state = readState();
  const previousCache =
    state.cache && typeof state.cache === 'object' ? state.cache : null;
  const cacheFresh =
    previousCache !== null &&
    typeof previousCache.at === 'number' &&
    Date.now() - previousCache.at < CACHE_TTL_MS;
  let error = null;
  let cache = previousCache;

  if (force || !cacheFresh) {
    const next = { at: Date.now(), latest: previousCache?.latest ?? null, releases: previousCache?.releases ?? [] };
    try {
      next.latest = await fetchLatestVersion();
    } catch (cause) {
      if (next.latest === null) error = `无法从 npm 获取最新版本：${describeError(cause)}`;
    }
    try {
      next.releases = await fetchReleases();
    } catch (cause) {
      if (error === null && next.releases.length === 0) {
        error = `无法从 GitHub 获取更新说明：${describeError(cause)}`;
      }
    }
    next.at = Date.now();
    if (next.latest !== null || next.releases.length > 0) {
      cache = next;
      patchState({ cache });
    } else if (previousCache !== null) {
      cache = previousCache;
    }
  }

  const latest = cache && typeof cache.latest === 'string' ? cache.latest : null;
  const releases = Array.isArray(cache?.releases) ? cache.releases : [];
  let pending = [];
  if (latest !== null) {
    pending = releases
      .filter((release) =>
        current === null ? true : compareVersions(release.version, current) > 0,
      )
      .filter((release) => compareVersions(release.version, latest) <= 0);
    if (!pending.some((release) => release.version === latest)) {
      pending.unshift(syntheticRelease(latest));
    }
    pending = pending.slice(0, MAX_PENDING_RELEASES);
  }
  const updateAvailable =
    current !== null && latest !== null && compareVersions(latest, current) > 0;
  const latestRelease = pending.find((release) => release.version === latest) ?? null;
  const running = activeUpdate();
  const prepared = preparedUpdate();

  return {
    package: PACKAGE,
    current,
    latest,
    channel: 'latest',
    updateAvailable,
    updating: running !== null,
    updatePhase: running === null ? null : (running.mode ?? null),
    updateTarget: running === null ? null : (running.target ?? null),
    updatingVersion: running === null ? null : (running.target ?? null),
    prepared: prepared === null ? null : { version: prepared.version, at: prepared.at ?? null },
    ignoredVersion: typeof state.ignoredVersion === 'string' ? state.ignoredVersion : null,
    ignored: latest !== null && state.ignoredVersion === latest,
    pending,
    notesAvailable: Boolean(latestRelease && latestRelease.sections.length > 0),
    lastUpdate: state.lastUpdate ?? null,
    checkedAt: typeof cache?.at === 'number' ? new Date(cache.at).toISOString() : null,
    error,
  };
}

/* ----------------------- *
 * HTTP fence and helpers  *
 * ----------------------- */

function loopbackAuthority(host) {
  if (typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  const name = lower.startsWith('[')
    ? lower.slice(0, lower.indexOf(']') + 1)
    : lower.split(':')[0];
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function loopbackPeer(request) {
  const address = request.socket && request.socket.remoteAddress;
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function forwardedRequest(request) {
  return (
    request.headers.forwarded !== undefined ||
    request.headers['x-forwarded-for'] !== undefined ||
    request.headers['x-real-ip'] !== undefined
  );
}

/**
 * Only a direct loopback page may read or drive this endpoint. The Host header
 * must name a loopback authority (the rebinding defence), and any Origin that
 * is present must match it (the cross-site defence).
 */
function trustedRequest(request) {
  if (!loopbackPeer(request)) return false;
  if (forwardedRequest(request)) return false;
  const host = request.headers.host;
  if (!loopbackAuthority(host)) return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function methodNotAllowed(response, allow) {
  sendJson(response, 405, { error: `只接受 ${allow} 请求` });
}

async function readJsonBody(request, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text === '' ? {} : JSON.parse(text);
}

/* ----------------- *
 * Route behaviors   *
 * ----------------- */

async function handleStatus(request, response) {
  if (!trustedRequest(request)) {
    sendJson(response, 403, { error: '这个请求来源不受信任' });
    return;
  }
  if (request.method !== 'GET') {
    methodNotAllowed(response, 'GET');
    return;
  }
  let force = false;
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    force = url.searchParams.get('refresh') === '1';
  } catch {
    /* keep the cached answer */
  }
  sendJson(response, 200, await buildStatus(force));
}

async function handleIgnore(request, response) {
  if (!trustedRequest(request)) {
    sendJson(response, 403, { error: '这个请求来源不受信任' });
    return;
  }
  if (request.method !== 'POST') {
    methodNotAllowed(response, 'POST');
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: '请求体不是有效 JSON' });
    return;
  }
  const version = payload.version === undefined ? null : payload.version;
  if (version !== null && (typeof version !== 'string' || !VERSION_PATTERN.test(version))) {
    sendJson(response, 400, { error: '版本号格式不正确' });
    return;
  }
  patchState({ ignoredVersion: version });
  sendJson(response, 200, { ignoredVersion: version });
}

async function handleApply(request, response) {
  if (!trustedRequest(request)) {
    sendJson(response, 403, { error: '这个请求来源不受信任' });
    return;
  }
  if (request.method !== 'POST') {
    methodNotAllowed(response, 'POST');
    return;
  }
  let payload;
  try {
    payload = await readJsonBody(request);
  } catch {
    sendJson(response, 400, { error: '请求体不是有效 JSON' });
    return;
  }
  let status = await buildStatus(false);
  if (status.latest === null) status = await buildStatus(true);
  if (status.latest === null) {
    sendJson(response, 502, { error: status.error ?? '还没有获取到最新版本信息' });
    return;
  }
  if (status.current === null) {
    sendJson(response, 409, { error: '无法确认当前安装的 DSH 版本' });
    return;
  }
  if (!status.updateAvailable) {
    sendJson(response, 409, { error: '当前已经是最新版本' });
    return;
  }
  const running = activeUpdate();
  if (running !== null) {
    sendJson(response, 409, {
      error: `已有更新正在进行（PID ${running.pid}，目标 ${running.target ?? '未知'}），请等待它结束`,
    });
    return;
  }
  const target = status.latest;
  const prepared = preparedUpdate();
  if (prepared !== null && prepared.version === target) {
    sendJson(response, 200, {
      started: false,
      prepared: true,
      target,
      message: '新版本已下载并校验完成，可以重启并应用',
    });
    return;
  }
  const dryRun = payload.dryRun === true;
  const root = dshInstallRoot();
  const prefix = installPrefix(root);
  if (root === null || prefix === null) {
    sendJson(response, 500, { error: '无法定位 DSH 的全局安装目录' });
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(PLAN_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `stage-${stamp}.log`);
  const stageRoot = join(prefix, `.dsh-stage-${stamp}`);
  const npmArgs = [
    'install',
    '-g',
    '--no-fund',
    '--no-audit',
    '--fetch-timeout=60000',
    '--fetch-retries=5',
    '--prefix',
    stageRoot,
    `${PACKAGE}@${target}`,
  ];
  const npmInvocation = resolveNpmInvocation({ execPath: process.execPath, args: npmArgs });
  const plan = {
    createdAt: new Date().toISOString(),
    mode: 'stage',
    package: PACKAGE,
    current: status.current,
    target,
    npm: npmInvocation,
    launch: {
      file: process.execPath,
      args: process.argv.slice(1),
      cwd: process.cwd(),
    },
    port: servingPort(request),
    hostPid: process.pid,
    prefix,
    liveRoot: root,
    stageRoot,
    stateFile: STATE_FILE,
    logPath,
    dryRun,
  };
  const planPath = join(PLAN_DIR, `stage-${stamp}.json`);
  try {
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  } catch (cause) {
    sendJson(response, 500, { error: `无法写入下载计划：${describeError(cause)}` });
    return;
  }
  if (dryRun) {
    sendJson(response, 200, {
      started: false,
      dryRun: true,
      target,
      stageRoot,
      logPath,
      planPath,
      command: [plan.npm.command, ...plan.npm.args].join(' '),
    });
    return;
  }
  const helperPath = fileURLToPath(new URL('./stage-helper.mjs', import.meta.url));
  if (!existsSync(helperPath)) {
    sendJson(response, 500, { error: '下载助手脚本缺失，未做任何改动' });
    return;
  }
  let child;
  try {
    child = spawn(process.execPath, [helperPath, planPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch (cause) {
    sendJson(response, 500, { error: `无法启动下载助手：${describeError(cause)}` });
    return;
  }
  patchState({
    lastUpdate: {
      version: target,
      at: plan.createdAt,
      phase: 'staging',
      ok: null,
      logPath,
    },
  });
  sendJson(response, 200, {
    started: true,
    phase: 'stage',
    target,
    from: status.current,
    stageRoot,
    logPath,
    planPath,
    helperPid: child.pid ?? null,
  });
}

/**
 * Phase 2: swap the verified staging tree into place. The Host answers, then
 * exits; switch-helper does the stop -> rename -> start sequence and rolls back
 * on failure. This is the same shape as the manual restore that took ~8s.
 */
async function handleSwitch(request, response) {
  if (!trustedRequest(request)) {
    sendJson(response, 403, { error: '这个请求来源不受信任' });
    return;
  }
  if (request.method !== 'POST') {
    methodNotAllowed(response, 'POST');
    return;
  }
  const prepared = preparedUpdate();
  if (prepared === null) {
    sendJson(response, 409, { error: '还没有下载好的新版本，请先点“检查更新”下载' });
    return;
  }
  const status = await buildStatus(false);
  if (status.current === prepared.version) {
    patchState({ staged: null });
    sendJson(response, 409, { error: `当前已经是 v${prepared.version}` });
    return;
  }
  const running = activeUpdate();
  if (running !== null) {
    sendJson(response, 409, {
      error: `已有更新正在进行（PID ${running.pid}），请等待它结束`,
    });
    return;
  }
  const target = prepared.version;
  const root = dshInstallRoot();
  if (root === null) {
    sendJson(response, 500, { error: '无法定位 DSH 的全局安装目录' });
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(PLAN_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `switch-${stamp}.log`);
  const backupDir = join(dirname(root), `dsh.bak-${stamp}`);
  const plan = {
    createdAt: new Date().toISOString(),
    mode: 'switch',
    package: PACKAGE,
    target,
    npm: {},
    launch: {
      file: process.execPath,
      args: process.argv.slice(1),
      cwd: process.cwd(),
    },
    port: servingPort(request),
    hostPid: process.pid,
    liveRoot: root,
    stageRoot: prepared.dir,
    backupDir,
    stateFile: STATE_FILE,
    logPath,
  };
  const planPath = join(PLAN_DIR, `switch-${stamp}.json`);
  try {
    writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  } catch (cause) {
    sendJson(response, 500, { error: `无法写入切换计划：${describeError(cause)}` });
    return;
  }
  const helperPath = fileURLToPath(new URL('./switch-helper.mjs', import.meta.url));
  if (!existsSync(helperPath)) {
    sendJson(response, 500, { error: '切换助手脚本缺失，未做任何改动' });
    return;
  }
  let child;
  try {
    child = spawn(process.execPath, [helperPath, planPath], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } catch (cause) {
    sendJson(response, 500, { error: `无法启动切换助手：${describeError(cause)}` });
    return;
  }
  patchState({
    lastUpdate: {
      version: target,
      at: plan.createdAt,
      phase: 'switching',
      ok: null,
      logPath,
    },
  });
  sendJson(response, 200, {
    started: true,
    phase: 'switch',
    target,
    from: status.current,
    logPath,
    planPath,
    helperPid: child.pid ?? null,
  });
  const timer = setTimeout(() => {
    try {
      process.kill(process.pid, 'SIGTERM');
    } catch {
      /* already exiting */
    }
  }, 900);
  if (typeof timer.unref === 'function') timer.unref();
}

/* -------------- *
 * Plugin wiring  *
 * -------------- */

const inject = ['webServer'];

function apply(ctx) {
  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(
      () => {
        const disposers = [
          hostCtx.webServer.register({
            kind: 'exact',
            path: '/dsh-update/status',
            handler: (request, response) =>
              handleStatus(request, response).catch((cause) =>
                sendJson(response, 500, { error: describeError(cause) }),
              ),
          }),
          hostCtx.webServer.register({
            kind: 'exact',
            path: '/dsh-update/ignore',
            handler: (request, response) =>
              handleIgnore(request, response).catch((cause) =>
                sendJson(response, 500, { error: describeError(cause) }),
              ),
          }),
          hostCtx.webServer.register({
            kind: 'exact',
            path: '/dsh-update/apply',
            handler: (request, response) =>
              handleApply(request, response).catch((cause) =>
                sendJson(response, 500, { error: describeError(cause) }),
              ),
          }),
          hostCtx.webServer.register({
            kind: 'exact',
            path: '/dsh-update/switch',
            handler: (request, response) =>
              handleSwitch(request, response).catch((cause) =>
                sendJson(response, 500, { error: describeError(cause) }),
              ),
          }),
        ];
        return () => {
          for (const dispose of disposers.splice(0)) {
            try {
              dispose();
            } catch {
              /* route already gone */
            }
          }
        };
      },
      'dsh-update-center: update routes',
    );
  });
}

export { apply, inject, compareVersions, parseReleaseNotes };
