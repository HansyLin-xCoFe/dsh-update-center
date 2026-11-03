/**
 * dsh-update-center — detached update helper.
 *
 * Spawned by the Host plugin's /dsh-update/apply route with a plan file. It
 * outlives the Host process: waits for the Web port to be released, runs the
 * global npm install, relaunches the exact DSH invocation that booted the
 * previous Host, and records every stage in a log file plus the plugin's
 * state.json so the next boot can show what happened.
 *
 * Usage: node update-helper.mjs <plan.json>
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname } from 'node:path';

const planPath = process.argv[2];
if (!planPath) {
  process.exit(2);
}

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, 'utf8'));
} catch {
  process.exit(2);
}

mkdirSync(dirname(plan.logPath), { recursive: true });

const log = (line) => {
  try {
    appendFileSync(plan.logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* the log itself must never abort an update */
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isListening() {
  if (!plan.port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: plan.port });
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

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(plan.stateFile, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function patchState(patch) {
  const next = {
    ...readState(),
    lastUpdate: {
      ...(readState().lastUpdate ?? {}),
      version: plan.target,
      logPath: plan.logPath,
      ...patch,
    },
  };
  try {
    writeFileSync(plan.stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* state is a convenience, not a requirement */
  }
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options);
    child.once('error', (error) => resolve({ code: -1, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPortFree(timeoutMs) {
  if (!plan.port) {
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

let logFd = 'ignore';
try {
  logFd = openSync(plan.logPath, 'a');
} catch {
  logFd = 'ignore';
}

async function main() {
  log(`helper started (pid ${process.pid}); ${plan.current ?? '?'} -> ${plan.target}`);
  patchState({ phase: 'waiting-host-exit', at: plan.createdAt, ok: null });
  const released = await waitForPortFree(30000);
  log(released ? `host port ${plan.port} is free` : `host port ${plan.port} still listening after 30s; continuing`);

  patchState({ phase: 'installing' });
  log(`running ${plan.npm.command} ${plan.npm.args.join(' ')}`);
  const npm = await run(plan.npm.command, plan.npm.args, {
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    shell: process.platform === 'win32',
    env: process.env,
  });
  const installOk = npm.code === 0;
  log(
    `npm finished with code ${String(npm.code)}${
      npm.error ? ` (${npm.error && npm.error.message ? npm.error.message : npm.error})` : ''
    }`,
  );
  if (!installOk) log('npm install failed; relaunching the host anyway so the current install can still boot');

  patchState({ phase: 'restarting', installOk });
  await waitForPortFree(10000);

  const launch = plan.launch;
  let child;
  try {
    if (process.platform === 'win32') {
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
    child.once('error', (error) => {
      log(`could not start the replacement: ${error && error.message ? error.message : error}`);
    });
    child.unref();
    log(`replacement launched (pid ${String(child.pid ?? 'unknown')})`);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    log(`could not start the replacement: ${message}`);
    patchState({
      phase: 'failed',
      ok: false,
      error: `无法启动 DSH：${message}`,
      finishedAt: new Date().toISOString(),
    });
    process.exit(1);
  }

  const startedAt = Date.now();
  let up = false;
  while (Date.now() - startedAt < 120000) {
    if (await isListening()) {
      up = true;
      break;
    }
    await sleep(500);
  }
  log(up ? `replacement is listening on port ${plan.port}` : 'replacement did not answer within 120s');
  const error = up
    ? installOk
      ? null
      : 'npm install 失败，已按旧版本重启，请查看日志'
    : 'DSH 重启后未在 120 秒内监听端口，请查看日志';
  patchState({
    phase: up ? (installOk ? 'done' : 'done-with-install-error') : 'startup-timeout',
    ok: installOk && up,
    error,
    finishedAt: new Date().toISOString(),
  });
  log('helper finished');
  process.exit(up ? 0 : 1);
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
