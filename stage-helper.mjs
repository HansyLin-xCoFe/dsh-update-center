/**
 * Stage helper — phase 1 of the staged update.
 *
 * Downloads and verifies a new DSH tree in an isolated staging prefix while the
 * running DSH keeps serving. It NEVER touches the live installation, so a slow
 * or broken npm run can no longer damage or remove DSH (the 2026-11-09 failure
 * killed a 15-minute npm install and then could not clean up the live tree).
 *
 * On success it records `staged: { version, dir, at }` in state.json; the Host
 * then offers "restart and apply", and switch-helper does the 8-second swap.
 *
 * Usage: node stage-helper.mjs <plan.json>
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRuntime } from './update-common.mjs';

const planPath = process.argv[2];
if (!planPath) process.exit(2);

let plan;
try {
  plan = JSON.parse(readFileSync(planPath, 'utf8'));
} catch {
  process.exit(2);
}

const rt = createRuntime(plan);
const IDLE_EXTEND_MS = 10 * 60 * 1000;
const HARD_CAP_MS = 45 * 60 * 1000;
const PROGRESS_CHECK_MS = 15 * 1000;
const NPM_LOG_GROWTH_BYTES = 256;

function stagedDshRoot() {
  return join(plan.stageRoot, 'node_modules', '@deepseek-ai', 'dsh');
}

function npmLogSize() {
  try {
    return statSync(plan.logPath).size;
  } catch {
    return 0;
  }
}

function runInstall() {
  return new Promise((resolve) => {
    let child;
    const options = {
      stdio: ['ignore', rt.logFd, rt.logFd],
      windowsHide: true,
      env: process.env,
    };
    try {
      if (rt.npmInvocation.shell === false) {
        child = spawn(rt.npmInvocation.command, rt.npmInvocation.args, options);
      } else {
        resolve({ code: -1, error: new Error('npm fallback shim is not supported by the stage helper') });
        return;
      }
    } catch (error) {
      resolve({ code: -1, error });
      return;
    }

    const startedAt = Date.now();
    let hardDeadline = startedAt + HARD_CAP_MS;
    let idleDeadline = startedAt + IDLE_EXTEND_MS;
    let lastSize = npmLogSize();
    let finished = false;

    const progress = setInterval(() => {
      if (finished) return;
      const size = npmLogSize();
      if (size - lastSize >= NPM_LOG_GROWTH_BYTES) {
        lastSize = size;
        idleDeadline = Date.now() + IDLE_EXTEND_MS;
      }
      const now = Date.now();
      if (now >= idleDeadline || now >= hardDeadline) {
        rt.log(`npm produced no progress for 10 minutes (or hit the 45-minute cap); terminating its process tree`);
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        if (rt.isWindows) {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            encoding: 'utf8',
            windowsHide: true,
          });
        }
      }
    }, PROGRESS_CHECK_MS);
    if (typeof progress.unref === 'function') progress.unref();

    child.once('error', (error) => {
      clearInterval(progress);
      finished = true;
      resolve({ code: -1, error });
    });
    child.once('exit', (code, signal) => {
      clearInterval(progress);
      finished = true;
      resolve({ code, signal });
    });
  });
}

async function main() {
  const target = plan.target;
  rt.log(`stage helper started (pid ${process.pid}); target ${target}`);
  if (!rt.lock.acquire('stage')) {
    rt.patchState({
      lastUpdate: {
        version: target,
        phase: 'stage-rejected',
        ok: false,
        error: '已有另一个更新进程在运行，本次未做任何改动',
        logPath: plan.logPath,
        finishedAt: new Date().toISOString(),
      },
    });
    process.exit(3);
  }
  process.on('exit', () => rt.lock.release());

  const free = rt.freeBytes(plan.prefix);
  if (free !== null && free < 2 * 1024 * 1024 * 1024) {
    rt.log(`only ${(free / 1024 / 1024 / 1024).toFixed(2)} GiB free; a staged install needs ~2 GiB`);
    rt.patchState({
      staged: null,
      lastUpdate: {
        version: target,
        phase: 'stage-failed',
        ok: false,
        error: '磁盘剩余空间不足 2 GiB，已取消下载（未改动任何文件）',
        logPath: plan.logPath,
        finishedAt: new Date().toISOString(),
      },
    });
    process.exit(1);
  }

  rt.patchState({
    staged: null,
    lastUpdate: {
      version: target,
      phase: 'staging',
      ok: null,
      logPath: plan.logPath,
      at: new Date().toISOString(),
    },
  });

  rt.log(`running npm via ${rt.npmInvocation.via}: ${rt.npmInvocation.command} ${rt.npmInvocation.args.join(' ')}`);
  const npm = await runInstall();
  rt.log(`npm finished with code ${String(npm.code)}${npm.error ? ` (${npm.error.message})` : ''}`);

  const root = stagedDshRoot();
  const stagedBin = join(root, 'lib', 'bin.js');
  let stagedVersion = null;
  try {
    stagedVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  } catch {
    stagedVersion = null;
  }

  let verified = npm.code === 0 && existsSync(stagedBin) && stagedVersion === target;
  if (verified) {
    const probe = spawnSync(process.execPath, [stagedBin, '--version'], {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      cwd: plan.launch && plan.launch.cwd ? plan.launch.cwd : process.cwd(),
    });
    const stdout = String((probe && probe.stdout) || '').trim();
    if (probe.status !== 0 || !stdout.includes(target)) {
      rt.log(`staged binary did not answer "--version ${target}": status=${String(probe.status)} out=${stdout}`);
      verified = false;
    }
  }

  if (!verified) {
    rt.removeTree(plan.stageRoot, 'staging tree');
    rt.patchState({
      staged: null,
      lastUpdate: {
        version: target,
        phase: 'stage-failed',
        ok: false,
        error: '新版本下载/校验失败，正式安装未做任何改动',
        logPath: plan.logPath,
        finishedAt: new Date().toISOString(),
      },
    });
    process.exit(1);
  }

  rt.removeTree(join(plan.stageRoot, 'node_modules', '.bin'), 'staging bin shims');
  rt.patchState({
    staged: {
      version: target,
      dir: plan.stageRoot,
      at: new Date().toISOString(),
    },
    lastUpdate: {
      version: target,
      phase: 'staged',
      ok: null,
      error: null,
      logPath: plan.logPath,
      finishedAt: null,
    },
  });
  rt.log(`stage done: ${target} is staged at ${plan.stageRoot}`);
  process.exit(0);
}

main().catch((error) => {
  rt.log(`stage helper crashed: ${error && error.stack ? error.stack : String(error)}`);
  rt.patchState({
    staged: null,
    lastUpdate: {
      version: plan.target,
      phase: 'stage-failed',
      ok: false,
      error: '下载助手异常退出，请查看日志',
      logPath: plan.logPath,
      finishedAt: new Date().toISOString(),
    },
  });
  process.exit(1);
});
