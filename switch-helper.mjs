/**
 * Switch helper — phase 2 of the staged update.
 *
 * The new tree was downloaded and verified by stage-helper while DSH kept
 * running. This helper performs the same kind of local swap that the manual
 * rollback proved reliable (stop -> rename live aside -> rename staged in ->
 * start -> verify), and puts the previous tree back if the new one does not
 * come up. No npm, no network.
 *
 * Usage: node switch-helper.mjs <plan.json>
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
const STARTUP_TIMEOUT = Number(plan.startupTimeoutMs) > 0 ? Number(plan.startupTimeoutMs) : 120000;
const target = plan.target;
const liveRoot = plan.liveRoot;
const stageRoot = plan.stageRoot;
const stagedDsh = join(stageRoot, 'node_modules', '@deepseek-ai', 'dsh');
const stagedBin = join(stagedDsh, 'lib', 'bin.js');
const liveBin = join(liveRoot, 'lib', 'bin.js');
const backupDir = plan.backupDir || join(dirname(liveRoot), `dsh.bak-${stamp}`);

function failState(phase, message) {
  rt.patchState({
    lastUpdate: {
      version: target,
      phase,
      ok: false,
      error: message,
      logPath: plan.logPath,
      finishedAt: new Date().toISOString(),
    },
  });
}

async function main() {
  rt.log(`switch helper started (pid ${process.pid}); target ${target}`);
  rt.log(`live=${liveRoot} staged=${stageRoot} backup=${backupDir}`);

  if (!rt.lock.acquire('switch')) {
    failState('switch-rejected', '已有另一个更新进程在运行，本次未做任何改动');
    process.exit(3);
  }
  process.on('exit', () => rt.lock.release());

  if (!existsSync(stagedBin)) {
    rt.log('staged tree is missing its lib/bin.js; aborting without touching the live install');
    failState('switch-failed', '暂存的新版本不完整，已取消切换（未改动安装）');
    if (plan.hostPid) {
      rt.forceKillPid(plan.hostPid, true);
      await rt.waitForPortFree(15000);
    }
    rt.launchHost();
    await rt.waitForStableStartup(STARTUP_TIMEOUT);
    process.exit(1);
  }

  /* 1. Old host must be gone. */
  rt.patchState({
    lastUpdate: { version: target, phase: 'switching', ok: null, logPath: plan.logPath },
  });
  if (plan.hostPid) {
    rt.log(`waiting for old host pid ${plan.hostPid} to exit`);
    if (!(await rt.waitForPidGone(plan.hostPid, 35000))) {
      rt.log('old host is still alive; refusing to swap anything');
      failState('switch-failed', '旧 DSH 进程未退出，已取消切换（未改动安装）');
      process.exit(1);
    }
  }
  if (!(await rt.waitForPortFree(15000))) {
    const lingering = rt.findListenerPid();
    if (lingering) {
      rt.log(`port still held by pid ${lingering}; terminating it`);
      rt.forceKillPid(lingering, true);
      await rt.waitForPortFree(15000);
    }
  }
  if (!(await rt.waitForPortFree(5000))) {
    failState('switch-failed', 'Web 端口仍被占用，已取消切换（未改动安装）');
    rt.launchHost();
    await rt.waitForStableStartup(STARTUP_TIMEOUT);
    process.exit(1);
  }

  /* 2. Swap: live -> backup, staged -> live. */
  const hadLive = existsSync(liveBin);
  let backedUp = false;
  if (hadLive) {
    if (!(await rt.renameWithRetry(liveRoot, backupDir))) {
      rt.log('could not move the current install aside; aborting and restarting the old version');
      failState('switch-failed', '无法把当前安装移开，已取消切换并重启旧版本');
      rt.launchHost();
      await rt.waitForStableStartup(STARTUP_TIMEOUT);
      process.exit(1);
    }
    backedUp = true;
    rt.log(`current install moved to ${backupDir}`);
  } else {
    rt.log('no usable current install; placing the staged tree directly');
  }

  if (!(await rt.renameWithRetry(stagedDsh, liveRoot))) {
    rt.log('could not move the staged tree into place; restoring the previous install');
    if (backedUp) await rt.renameWithRetry(backupDir, liveRoot);
    failState('switch-failed', '无法把新版本移入安装目录，已回滚到旧版本');
    rt.launchHost();
    await rt.waitForStableStartup(STARTUP_TIMEOUT);
    process.exit(1);
  }

  if (!existsSync(liveBin)) {
    rt.log('swapped tree has no lib/bin.js; rolling back');
    const badDir = join(dirname(liveRoot), `dsh.failed-${stamp}`);
    await rt.renameWithRetry(liveRoot, badDir);
    if (backedUp) await rt.renameWithRetry(backupDir, liveRoot);
    failState('switch-failed', '新版本缺少 lib/bin.js，已回滚到旧版本');
    rt.launchHost();
    await rt.waitForStableStartup(STARTUP_TIMEOUT);
    process.exit(1);
  }

  /* 3. Start the new version; roll back if it does not come up. */
  rt.log('new tree is in place; starting it');
  if (!rt.launchHost()) {
    failState('switch-failed', '新版本无法启动，已尝试回滚');
    process.exit(1);
  }
  const up = await rt.waitForStableStartup(STARTUP_TIMEOUT);
  if (up) {
    rt.removeTree(stageRoot, 'staging prefix');
    rt.patchState({
      staged: null,
      lastUpdate: {
        version: target,
        phase: 'done',
        ok: true,
        error: null,
        logPath: plan.logPath,
        backupPath: backedUp ? backupDir : null,
        finishedAt: new Date().toISOString(),
      },
    });
    rt.log(`switch done; DSH ${target} is listening${backedUp ? `; previous tree kept at ${backupDir}` : ''}`);
    process.exit(0);
  }

  /* 4. Rollback. */
  rt.log('new version did not come up; rolling back');
  const newPid = rt.findListenerPid();
  if (newPid) rt.forceKillPid(newPid, true);
  await rt.waitForPortFree(15000);
  const badDir = join(dirname(liveRoot), `dsh.failed-${stamp}`);
  await rt.renameWithRetry(liveRoot, badDir);
  let restored = false;
  if (backedUp) restored = await rt.renameWithRetry(backupDir, liveRoot);
  const launched = restored ? rt.launchHost() : false;
  const backUp = launched ? await rt.waitForStableStartup(STARTUP_TIMEOUT) : false;
  rt.removeTree(stageRoot, 'staging prefix');
  const phase = backUp ? 'rolled-back' : restored ? 'rolled-back-start-failed' : 'switch-failed';
  const error = backUp
    ? '新版本启动失败，已回滚到更新前的版本'
    : restored
      ? '新版本启动失败，旧版本文件已还原但未能自动启动，请手动启动 DSH'
      : `新版本启动失败且无法还原，请手动把 ${backedUp ? backupDir : '（无备份）'} 改回 ${liveRoot}`;
  rt.patchState({
    lastUpdate: {
      version: target,
      phase,
      ok: false,
      error,
      logPath: plan.logPath,
      finishedAt: new Date().toISOString(),
    },
  });
  rt.log(backUp ? 'rollback complete; previous version is listening' : 'rollback FAILED; manual action needed');
  process.exit(backUp ? 2 : 1);
}

main().catch((error) => {
  rt.log(`switch helper crashed: ${error && error.stack ? error.stack : String(error)}`);
  failState('switch-failed', '切换助手异常退出，请查看日志');
  process.exit(1);
});
