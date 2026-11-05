/**
 * dsh-update-center — detached update helper (safety-hardened).
 *
 * Spawned by the Host plugin's /dsh-update/apply route with a plan file. It
 * outlives the Host process and is the only component allowed to touch the
 * global npm installation.
 *
 * The 2026-11-05 incident (two concurrent `npm install -g` runs deleted the
 * package tree while the old DSH was being torn down) drives every guard below:
 *
 *   1. ONE helper at a time — an exclusive `update.lock` beside state.json.
 *   2. The old Host process must be GONE (PID verified, force-killed when it
 *      lingers) before npm runs; a missing PID is rediscovered from the port.
 *   3. The old installation directory is RENAMED to a backup before npm runs,
 *      so a failed install can be rolled back byte for byte.
 *   4. Disk space is checked, npm runs with a timeout, and the new tree is
 *      verified (`lib/bin.js` present) before anything is launched.
 *   5. A new version that fails to boot is rolled back to the backup and the
 *      old version is relaunched.
 *
 * Every stage goes to plan.logPath; the outcome goes to plan.stateFile.
 * Backwards compatible with older plans that only carry npm/launch/port.
 *
 * Usage: node update-helper.mjs <plan.json>
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import { resolveNpmForPlan } from './npm-invocation.mjs';

/* ------------------------------------------------------------------ *
 * Plan + constants                                                   *
 * ------------------------------------------------------------------ */

const planPath = process.argv[2];
if (!planPath) process.exit(2);

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, 'utf8'));
} catch {
  process.exit(2);
}

const isWindows = process.platform === 'win32';
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const stateFile = plan.stateFile;
const lockFile = join(dirname(stateFile), 'update.lock');

/*
 * npm invocation. A plan written by an older Host half carries
 * `command: 'npm.cmd'`; such a plan cannot be spawned from this console-less
 * helper (cmd.exe dies with ERROR_NETNAME_DELETED). npm-invocation rewrites it
 * to the form that is proven to work — node + npm-cli.js, no shell — so an
 * already-queued plan does not need a Host restart to succeed.
 */
const npmInvocation = resolveNpmForPlan(plan.npm, { execPath: process.execPath });
const npmCommand = npmInvocation.command;
const npmArgs = npmInvocation.args;
const launch = plan.launch;
const port = Number.isInteger(plan.port) && plan.port > 0 ? plan.port : null;
const FREE_SPACE_MIN_BYTES = 1.2 * 1024 * 1024 * 1024;
const NPM_TIMEOUT_MS = 15 * 60 * 1000;
const STARTUP_TIMEOUT_MS = 120 * 1000;

mkdirSync(dirname(plan.logPath), { recursive: true });
mkdirSync(dirname(stateFile), { recursive: true });

const log = (line) => {
  try {
    appendFileSync(plan.logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* the log itself must never abort an update */
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 * State / lock                                                       *
 * ------------------------------------------------------------------ */

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Atomic state write: the Host reads this file while we update it. */
function patchState(patch) {
  const current = readState();
  const next = {
    ...current,
    lastUpdate: {
      ...(current.lastUpdate ?? {}),
      version: plan.target,
      logPath: plan.logPath,
      ...patch,
    },
  };
  const temp = `${stateFile}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, stateFile);
  } catch {
    /* state is a convenience, not a requirement */
    try {
      rmSync(temp, { force: true });
    } catch {
      /* nothing to clean */
    }
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  try {
    const parsed = JSON.parse(readFileSync(lockFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** Take the one update lock; refuses when another live helper owns it. */
function acquireLock() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      writeFileSync(
        lockFile,
        `${JSON.stringify(
          { pid: process.pid, at: Date.now(), target: plan.target, plan: planPath },
          null,
          2,
        )}\n`,
        { encoding: 'utf8', flag: 'wx' },
      );
      return true;
    } catch {
      const current = readLock();
      const stale =
        current === null ||
        Date.now() - Number(current.at ?? 0) > 45 * 60 * 1000 ||
        !pidAlive(current.pid);
      if (!stale) {
        log(
          `another update is already running (pid ${current.pid}, target ${current.target ?? '?'}); refusing to start`,
        );
        return false;
      }
      try {
        rmSync(lockFile, { force: true });
      } catch {
        /* someone else may have removed it */
      }
    }
  }
  return false;
}

let ownsLock = false;
const releaseLock = () => {
  if (!ownsLock) return;
  ownsLock = false;
  try {
    const current = readLock();
    if (current === null || current.pid === process.pid) rmSync(lockFile, { force: true });
  } catch {
    /* best effort */
  }
};
process.on('exit', releaseLock);

/* ------------------------------------------------------------------ *
 * Process / port discovery                                           *
 * ------------------------------------------------------------------ */

function isListening() {
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    setTimeout(() => done(false), 800);
  });
}

function stdoutOf(command, args) {
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
    return result && typeof result.stdout === 'string' ? result.stdout : null;
  } catch {
    return null;
  }
}

/** PID listening on a local port, or null when it cannot be determined. */
function findListenerPid(localPort) {
  if (!localPort) return null;
  try {
    if (isWindows) {
      const output = stdoutOf('netstat', ['-ano', '-p', 'tcp']);
      if (output === null) return null;
      const needle = `:${localPort}`;
      for (const line of output.split('\n')) {
        const parts = line.trim().split(/\s+/u);
        if (
          parts.length >= 5 &&
          parts[0].toUpperCase() === 'TCP' &&
          parts[1].endsWith(needle) &&
          parts[3] === 'LISTENING'
        ) {
          const pid = Number(parts[4]);
          if (Number.isInteger(pid) && pid > 0) return pid;
        }
      }
      return null;
    }
    const output = stdoutOf('lsof', ['-nP', `-iTCP:${localPort}`, '-sTCP:LISTEN', '-t']);
    const pid = Number(String(output ?? '').trim().split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function waitForPidGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(300);
  }
  return !pidAlive(pid);
}

/**
 * Terminate one specific PID. `includeTree` is only for a replacement Host that
 * this helper itself started (it is not the helper's ancestor), never for the
 * old Host.
 */
function forceKillPid(pid, includeTree = false) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  log(`forcing pid ${pid} to stop${includeTree ? ' (its own subtree)' : ' (that process only)'}`);
  try {
    if (isWindows) {
      spawnSync('taskkill', ['/PID', String(pid), ...(includeTree ? ['/T'] : []), '/F'], {
        encoding: 'utf8',
        windowsHide: true,
      });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (error) {
    log(`force kill failed: ${error && error.message ? error.message : error}`);
  }
}

async function waitForPortFree(timeoutMs) {
  if (!port) {
    await sleep(1500);
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isListening())) return true;
    await sleep(300);
  }
  return !(await isListening());
}

/* ------------------------------------------------------------------ *
 * Install layout                                                     *
 * ------------------------------------------------------------------ */

function npmPrefixFromArgs(args) {
  const index = args.indexOf('--prefix');
  if (index !== -1 && index + 1 < args.length) return args[index + 1];
  for (const arg of args) {
    if (typeof arg === 'string' && arg.startsWith('--prefix=')) {
      return arg.slice('--prefix='.length);
    }
  }
  return null;
}

function resolveLayout() {
  let prefix = typeof plan.prefix === 'string' && plan.prefix !== '' ? plan.prefix : null;
  if (prefix === null) prefix = npmPrefixFromArgs(npmArgs);
  if (prefix === null && typeof plan.installRoot === 'string') {
    const match = /^(.*)[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh$/u.exec(plan.installRoot);
    if (match) prefix = match[1];
  }
  const root =
    typeof plan.installRoot === 'string' && plan.installRoot !== ''
      ? plan.installRoot
      : prefix === null
        ? null
        : join(prefix, 'node_modules', '@deepseek-ai', 'dsh');
  return { prefix, root };
}

function freeBytes(targetPath) {
  try {
    let candidate = targetPath;
    while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
    const stats = statfsSync(candidate);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * npm execution                                                      *
 * ------------------------------------------------------------------ */

function runInstall() {
  return new Promise((resolve) => {
    let child;
    const options = {
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
      env: process.env,
    };
    try {
      if (npmInvocation.shell === false) {
        /* The supported path: node + npm-cli.js, no shell, no console needed. */
        child = spawn(npmCommand, npmArgs, options);
      } else if (isWindows && /\.(cmd|bat)$/iu.test(npmCommand)) {
        /*
         * Fallback only (no npm-cli.js found). cmd.exe needs a console and this
         * helper has none, so this path is known to fail on some Windows hosts;
         * the log line above names the fallback so a failure is diagnosable.
         */
        const line = [npmCommand, ...npmArgs]
          .map((part) => `"${String(part).replace(/"/gu, '""')}"`)
          .join(' ');
        child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], options);
      } else {
        child = spawn(npmCommand, npmArgs, options);
      }
    } catch (error) {
      resolve({ code: -1, error });
      return;
    }
    const timer = setTimeout(() => {
      log('npm install exceeded 15 minutes; terminating it');
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, NPM_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, error });
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Launch                                                             *
 * ------------------------------------------------------------------ */

function launchHost() {
  let child;
  try {
    if (isWindows) {
      const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
      const command = [`& ${quote(launch.file)}`, ...launch.args.map(quote)].join(' ');
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command],
        {
          cwd: launch.cwd,
          detached: false,
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
          env: process.env,
        },
      );
    } else {
      child = spawn(launch.file, launch.args, {
        cwd: launch.cwd,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: process.env,
      });
    }
    child.once('error', (error) =>
      log(`could not start the replacement: ${error && error.message ? error.message : error}`),
    );
    child.unref();
    log(`replacement launched (pid ${String(child.pid ?? 'unknown')})`);
    return true;
  } catch (error) {
    log(`could not start the replacement: ${error && error.message ? error.message : error}`);
    return false;
  }
}

/**
 * A replacement counts as up only after the port answers CONTINUOUSLY for
 * SETTLE_MS: DSH binds the web port before its activation audit runs, so a
 * single successful probe can belong to a harness that is about to exit.
 */
async function waitForStartup(timeoutMs) {
  const settleMs = 6000;
  const deadline = Date.now() + timeoutMs;
  let listeningSince = null;
  while (Date.now() < deadline) {
    if (await isListening()) {
      if (listeningSince === null) {
        listeningSince = Date.now();
      } else if (Date.now() - listeningSince >= settleMs) {
        return true;
      }
    } else {
      listeningSince = null;
    }
    await sleep(500);
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Filesystem helpers                                                 *
 * ------------------------------------------------------------------ */

function removeTree(path, label) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
    return true;
  } catch (error) {
    log(`could not remove ${label} ${path}: ${error && error.message ? error.message : error}`);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Main                                                               *
 * ------------------------------------------------------------------ */

let logFd = 'ignore';
try {
  logFd = openSync(plan.logPath, 'a');
} catch {
  logFd = 'ignore';
}

async function main() {
  log(`helper started (pid ${process.pid}); ${plan.current ?? '?'} -> ${plan.target}`);
  if (!acquireLock()) {
    patchState({
      phase: 'skipped-locked',
      ok: false,
      error: '已有另一个更新进程在运行，本次未做任何改动',
      finishedAt: new Date().toISOString(),
    });
    process.exit(3);
  }
  ownsLock = true;

  const layout = resolveLayout();
  if (layout.root === null) {
    log('cannot resolve the global DSH installation from the plan; aborting without changes');
    patchState({
      phase: 'failed',
      ok: false,
      error: '无法从更新计划解析 DSH 安装路径',
      finishedAt: new Date().toISOString(),
    });
    process.exit(1);
  }
  log(`install root: ${layout.root}`);
  if (layout.prefix !== null) log(`npm prefix: ${layout.prefix}`);

  const backupPath = join(dirname(layout.root), `dsh.bak-${stamp}`);

  /* 1. Make sure the old Host is really gone. */
  patchState({ phase: 'waiting-host-exit', ok: null, at: plan.createdAt });
  let hostPid = Number.isInteger(plan.hostPid) && plan.hostPid > 0 ? plan.hostPid : null;
  if (hostPid === null && port) {
    for (let attempt = 0; attempt < 10 && hostPid === null; attempt += 1) {
      hostPid = findListenerPid(port);
      if (hostPid === null) await sleep(500);
    }
  }
  if (hostPid !== null) {
    log(`old host pid: ${hostPid}`);
    /*
     * Never force-kill the old Host from here. In the ordinary /apply flow the
     * helper IS a child of that Host; on Windows terminating the Host takes the
     * helper with it (the 2026-11-05 10:46 controlled downgrade aborted exactly
     * this way: taskkill killed both, DSH stayed down). Aborting is the safe
     * outcome: nothing was changed and the user can restart DSH at will.
     */
    if (!(await waitForPidGone(hostPid, 35000))) {
      log(`old host pid ${hostPid} is still alive; aborting without touching the installation`);
      patchState({
        phase: 'failed',
        ok: false,
        error: '旧 DSH 进程未退出，已取消更新（未改动安装）。请先重启 DSH 再重试。',
        finishedAt: new Date().toISOString(),
      });
      process.exit(1);
    }
  } else {
    log('no old host pid; waiting for the port to free');
    if (!(await waitForPortFree(30000))) {
      log('the web port is still in use; aborting without touching the installation');
      patchState({
        phase: 'failed',
        ok: false,
        error: 'Web 端口仍被占用，已取消更新（未改动安装）。请先重启 DSH 再重试。',
        finishedAt: new Date().toISOString(),
      });
      process.exit(1);
    }
  }

  /* 2. Free-space guard: the backup and the fresh tree coexist while installing. */
  const free = freeBytes(dirname(layout.root));
  if (free !== null && free < FREE_SPACE_MIN_BYTES) {
    log(`only ${(free / 1024 / 1024 / 1024).toFixed(2)} GiB free on the install volume; refusing to install`);
    patchState({
      phase: 'failed',
      ok: false,
      error: '安装盘剩余空间不足 1.2 GiB，已取消更新（未改动安装）',
      finishedAt: new Date().toISOString(),
    });
    if (launchHost()) await waitForStartup(STARTUP_TIMEOUT_MS);
    process.exit(1);
  }

  /* 3. Back up the current installation by renaming it out of npm's tree. */
  const hadOldInstall = existsSync(join(layout.root, 'lib', 'bin.js'));
  let backedUp = false;
  if (hadOldInstall) {
    patchState({ phase: 'backing-up' });
    try {
      renameSync(layout.root, backupPath);
      backedUp = true;
      log(`backed up the current install to ${backupPath}`);
    } catch (error) {
      log(`could not back up the current install: ${error && error.message ? error.message : error}`);
      patchState({
        phase: 'failed',
        ok: false,
        error: '无法备份当前 DSH 安装，已取消更新（未改动安装）',
        finishedAt: new Date().toISOString(),
      });
      if (launchHost()) await waitForStartup(STARTUP_TIMEOUT_MS);
      process.exit(1);
    }
  } else {
    log('no existing install found; installing from scratch (no rollback possible)');
  }

  const restoreBackup = () => {
    if (!backedUp) return true;
    removeTree(layout.root, 'incomplete install');
    try {
      renameSync(backupPath, layout.root);
      backedUp = false;
      log('restored the previous installation from the backup');
      return true;
    } catch (error) {
      log(`CRITICAL: could not restore the backup from ${backupPath}: ${error && error.message ? error.message : error}`);
      return false;
    }
  };

  /* 4. Install. */
  patchState({ phase: 'installing' });
  log(`running npm via ${npmInvocation.via}${npmInvocation.rewritten ? '（已改写旧计划的 npm 调用方式）' : ''}: ${npmCommand} ${npmArgs.join(' ')}`);
  const npm = await runInstall();
  const installOk = npm.code === 0;
  log(`npm finished with code ${String(npm.code)}${npm.error ? ` (${npm.error.message})` : ''}`);

  const newBin = join(layout.root, 'lib', 'bin.js');
  if (!installOk || !existsSync(newBin)) {
    log('the new installation is missing or incomplete');
    const restored = restoreBackup();
    patchState({
      phase: restored ? 'rolled-back' : 'failed',
      installOk: false,
      ok: false,
      error: restored
        ? 'npm 安装失败，已回滚到更新前的版本'
        : `更新失败且自动恢复失败，请手动把 ${backupPath} 改回 ${layout.root}`,
      backupPath: restored ? null : backupPath,
      finishedAt: new Date().toISOString(),
    });
    const started = launchHost();
    const up = started ? await waitForStartup(STARTUP_TIMEOUT_MS) : false;
    log(up ? 'host is listening after rollback' : 'host did not come back up after rollback; see log');
    process.exit(1);
  }

  /* 5. Start the new version; roll back when it does not come up. */
  patchState({ phase: 'restarting', installOk: true });
  log('update installed; starting the new version');
  if (!launchHost()) {
    patchState({
      phase: 'start-failed',
      ok: false,
      error: '新版本已安装但无法拉起，请查看日志',
      finishedAt: new Date().toISOString(),
    });
    process.exit(1);
  }
  let up = await waitForStartup(STARTUP_TIMEOUT_MS);
  if (!up && backedUp) {
    log('the new version did not come up within 120s; rolling back');
    forceKillPid(findListenerPid(port), true);
    await sleep(1000);
    if (restoreBackup()) {
      launchHost();
      up = await waitForStartup(STARTUP_TIMEOUT_MS);
      patchState({
        phase: up ? 'rolled-back' : 'rolled-back-start-failed',
        ok: false,
        error: '新版本启动失败，已回滚到更新前的版本，请查看日志',
        finishedAt: new Date().toISOString(),
      });
      process.exit(up ? 0 : 1);
    }
    patchState({
      phase: 'failed',
      ok: false,
      error: `新版本启动失败且自动恢复失败，请手动把 ${backupPath} 改回 ${layout.root}`,
      backupPath,
      finishedAt: new Date().toISOString(),
    });
    process.exit(1);
  }

  if (up) {
    log('the new version is listening');
    patchState({ phase: 'done', ok: true, installOk: true, error: null, finishedAt: new Date().toISOString() });
    if (backedUp) {
      log('removing the previous installation backup');
      if (!removeTree(backupPath, 'backup')) log(`the backup remains at ${backupPath}`);
    }
    process.exit(0);
  }

  log('the new version did not answer within 120s (it may still be starting)');
  patchState({
    phase: 'startup-timeout',
    ok: false,
    installOk: true,
    error: '新版本已安装但 120 秒内未监听端口，请查看日志',
    backupPath: backedUp ? backupPath : null,
    finishedAt: new Date().toISOString(),
  });
  process.exit(1);
}

main().catch((error) => {
  log(`helper crashed: ${error && error.stack ? error.stack : String(error)}`);
  patchState({
    phase: 'failed',
    ok: false,
    error: '更新助手异常退出，请查看日志',
    finishedAt: new Date().toISOString(),
  });
  process.exit(1);
});
