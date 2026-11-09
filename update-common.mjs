/**
 * Shared runtime for the staged update helpers (stage-helper / switch-helper).
 *
 * Everything a helper needs that is not purely business logic lives here:
 * logging, atomic state writes, the single-instance lock, PID/port probes, npm
 * invocation, launching DSH, and tree removal with retries.
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

const LOCK_STALE_MS = 45 * 60 * 1000;
const STARTUP_SETTLE_MS = 6000;

export function createRuntime(plan) {
  const isWindows = process.platform === 'win32';
  const stateFile = plan.stateFile;
  const lockFile = join(dirname(stateFile), 'update.lock');
  const logPath = plan.logPath;
  const port = Number.isInteger(plan.port) && plan.port > 0 ? plan.port : null;

  mkdirSync(dirname(logPath), { recursive: true });
  mkdirSync(dirname(stateFile), { recursive: true });

  let logFd = 'ignore';
  try {
    logFd = openSync(logPath, 'a');
  } catch {
    logFd = 'ignore';
  }

  const log = (line) => {
    try {
      appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {
      /* logging must never abort an update */
    }
  };

  const readState = () => {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  const patchState = (patch) => {
    const current = readState();
    const next = { ...current, ...patch };
    if (patch.lastUpdate && typeof patch.lastUpdate === 'object') {
      next.lastUpdate = { ...(current.lastUpdate ?? {}), ...patch.lastUpdate };
    }
    const temp = `${stateFile}.${process.pid}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      renameSync(temp, stateFile);
    } catch {
      try {
        rmSync(temp, { force: true });
      } catch {
        /* nothing to clean */
      }
    }
  };

  const pidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const readLock = () => {
    try {
      const parsed = JSON.parse(readFileSync(lockFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  const acquireLock = (mode) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        writeFileSync(
          lockFile,
          `${JSON.stringify({ pid: process.pid, at: Date.now(), mode, target: plan.target }, null, 2)}\n`,
          { encoding: 'utf8', flag: 'wx' },
        );
        return true;
      } catch {
        const current = readLock();
        const stale =
          current === null ||
          Date.now() - Number(current.at ?? 0) > LOCK_STALE_MS ||
          !pidAlive(current.pid);
        if (!stale) {
          log(`another update is running (pid ${current.pid}, mode ${current.mode ?? '?'}); refusing to start`);
          return false;
        }
        try {
          rmSync(lockFile, { force: true });
        } catch {
          /* race, retry */
        }
      }
    }
    return false;
  };

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

  const isListening = () =>
    new Promise((resolve) => {
      if (!port) return resolve(false);
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

  const waitForPortFree = async (timeoutMs) => {
    if (!port) return true;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!(await isListening())) return true;
      await new Promise((done) => setTimeout(done, 300));
    }
    return !(await isListening());
  };

  const findListenerPid = () => {
    if (!port) return null;
    try {
      if (isWindows) {
        const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
        const output = result && typeof result.stdout === 'string' ? result.stdout : '';
        const needle = `:${port}`;
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
      const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
        encoding: 'utf8',
      });
      const pid = Number(String(result && result.stdout ? result.stdout : '').trim().split('\n')[0]);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  };

  const waitForPidGone = async (pid, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!pidAlive(pid)) return true;
      await new Promise((done) => setTimeout(done, 300));
    }
    return !pidAlive(pid);
  };

  const forceKillPid = (pid, includeTree = false) => {
    if (!Number.isInteger(pid) || pid <= 0) return;
    log(`forcing pid ${pid} to stop${includeTree ? ' (subtree)' : ''}`);
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
  };

  const launchHost = () => {
    try {
      let child;
      if (isWindows) {
        const quote = (value) => `'${String(value).replace(/'/gu, "''")}'`;
        const command = [`& ${quote(plan.launch.file)}`, ...plan.launch.args.map(quote)].join(' ');
        child = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', command], {
          cwd: plan.launch.cwd,
          detached: false,
          stdio: ['ignore', logFd, logFd],
          windowsHide: true,
          env: process.env,
        });
      } else {
        child = spawn(plan.launch.file, plan.launch.args, {
          cwd: plan.launch.cwd,
          detached: true,
          stdio: ['ignore', logFd, logFd],
          env: process.env,
        });
      }
      child.once('error', (error) => log(`launch error: ${error && error.message ? error.message : error}`));
      child.unref();
      log(`replacement launched (pid ${String(child.pid ?? 'unknown')})`);
      return true;
    } catch (error) {
      log(`could not launch replacement: ${error && error.message ? error.message : error}`);
      return false;
    }
  };

  /** The replacement must answer continuously: DSH binds the port before its audit. */
  const waitForStableStartup = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let listeningSince = null;
    while (Date.now() < deadline) {
      if (await isListening()) {
        if (listeningSince === null) listeningSince = Date.now();
        else if (Date.now() - listeningSince >= STARTUP_SETTLE_MS) return true;
      } else {
        listeningSince = null;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    return false;
  };

  const removeTree = (path, label) => {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 800 });
      return true;
    } catch (error) {
      log(`could not remove ${label} ${path}: ${error && error.message ? error.message : error}`);
      return false;
    }
  };

  const renameWithRetry = async (from, to, attempts = 10) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        renameSync(from, to);
        return true;
      } catch (error) {
        log(`rename ${from} -> ${to} failed (attempt ${attempt + 1}): ${error && error.message ? error.message : error}`);
        await new Promise((done) => setTimeout(done, 1500));
      }
    }
    return false;
  };

  const freeBytes = (targetPath) => {
    try {
      let candidate = targetPath;
      while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
      const stats = statfsSync(candidate);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  };

  const npmInvocation = resolveNpmForPlan(plan.npm, { execPath: process.execPath });

  return {
    isWindows,
    port,
    logFd,
    log,
    readState,
    patchState,
    lock: {
      acquire: (mode) => {
        ownsLock = acquireLock(mode);
        return ownsLock;
      },
      release: releaseLock,
      owns: () => ownsLock,
      file: lockFile,
    },
    pidAlive,
    readLock,
    isListening,
    waitForPortFree,
    findListenerPid,
    waitForPidGone,
    forceKillPid,
    launchHost,
    waitForStableStartup,
    removeTree,
    renameWithRetry,
    freeBytes,
    npmInvocation,
  };
}
