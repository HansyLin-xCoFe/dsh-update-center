/**
 * How this plugin starts npm.
 *
 * On Windows the obvious answer — spawn `npm.cmd` — does NOT work from the
 * detached update helper: the helper has no console, so the `cmd.exe /d /s /c`
 * shim it needs dies immediately with `指定的网络名不再可用。`
 * (ERROR_NETNAME_DELETED) and npm never runs. That cost two failed updates on
 * 2026-11-05 (11:17 and 11:37) even though the same command works in a normal
 * shell.
 *
 * What does work, proven by the 11:29 downgrade (`added 616 packages in 1m`), is
 * spawning the Node binary directly with npm's JS entry point and no shell:
 *
 *     node "<node dir>/node_modules/npm/bin/npm-cli.js" install -g ...
 *
 * Host half and update helper both resolve the invocation through this module,
 * so the plan, the log line, and the actual spawn always agree.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Candidate locations of npm's JS entry relative to the running node binary. */
export function npmCliCandidates(execPath, platform = process.platform) {
  const nodeDir = dirname(execPath);
  if (platform === 'win32') {
    return [
      join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
  }
  return [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
}

/** First existing npm-cli.js for this node, or null. */
export function findNpmCli(execPath, platform = process.platform, exists = existsSync) {
  for (const candidate of npmCliCandidates(execPath, platform)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Build the npm invocation for a plan.
 *
 * @param {object} options
 * @param {string} options.execPath - the node binary that will run it.
 * @param {string} [options.platform] - defaults to the current platform.
 * @param {string[]} options.args - npm arguments, e.g. ['install', '-g', ...].
 * @param {(path: string) => boolean} [options.exists] - injectable for tests.
 * @returns {{command: string, args: string[], shell: boolean, via: string}}
 *   `via` is written into the plan and the helper log so a failure is readable.
 */
export function resolveNpmInvocation({ execPath, platform = process.platform, args, exists = existsSync }) {
  const cli = findNpmCli(execPath, platform, exists);
  if (cli !== null) {
    return { command: execPath, args: [cli, ...args], shell: false, via: 'node+npm-cli.js' };
  }
  const shim = platform === 'win32' ? 'npm.cmd' : 'npm';
  return { command: shim, args: [...args], shell: platform === 'win32', via: `${shim} shim` };
}

/**
 * Normalize the `npm` block of an update plan.
 *
 * A plan written by a Host half before 1.2.0 says `command: 'npm.cmd'`, which
 * cannot be spawned from the console-less helper. Rewriting it here means an
 * already-queued plan still succeeds without waiting for a Host restart.
 *
 * @param {unknown} rawNpm - the plan's `npm` block (untrusted JSON).
 * @param {object} options
 * @param {string} options.execPath - the node binary that will run it.
 * @param {string} [options.platform]
 * @param {(path: string) => boolean} [options.exists]
 * @returns {{command: string, args: string[], shell: boolean, via: string, rewritten: boolean}}
 */
export function resolveNpmForPlan(rawNpm, { execPath, platform = process.platform, exists = existsSync }) {
  const raw = rawNpm && typeof rawNpm === 'object' ? rawNpm : {};
  const rawArgs = Array.isArray(raw.args) ? raw.args.filter((part) => typeof part === 'string') : [];
  const rawCommand = typeof raw.command === 'string' && raw.command !== '' ? raw.command : null;
  const looksLikeShim = rawCommand !== null && /\.(cmd|bat)$/iu.test(rawCommand);
  if (rawCommand !== null && !looksLikeShim && raw.shell === false) {
    return {
      command: rawCommand,
      args: rawArgs,
      shell: false,
      via: typeof raw.via === 'string' && raw.via !== '' ? raw.via : 'plan',
      rewritten: false,
    };
  }
  const resolved = resolveNpmInvocation({ execPath, platform, args: rawArgs, exists });
  return { ...resolved, rewritten: rawCommand === null || looksLikeShim || raw.shell !== false };
}
