# dsh-update-center

[中文](README.md) | **English**

An update center for the [DeepSeekRuntime](https://github.com/deepseek-ai/deepseek-harness) (DSH) Web UI:

- **Settings → General** gains a "DSH Update" row showing the installed and latest versions, with
  **Check for updates**, **Update now**, and an expandable/collapsible **Release highlights** block
  (parsed from GitHub Releases, listing every version between the installed one and the latest).
- **Bottom-left of the main window** shows a small prompt when a new release exists: **Update now**,
  **Ignore this version**, or **Later**, with the same expandable highlights.
- **Every page load** checks `@deepseek-ai/dsh`'s `latest` tag on npm once (cached for 10 minutes on
  the Host, so it never hammers the network).

> UI language follows DSH's locale setting (Chinese and English dictionaries are built in).

## What you see

| Where | What |
| --- | --- |
| Settings → General | Installed version, latest version, check button, update button, ignore/unignore, expandable highlights |
| Bottom-left prompt | New version, installed version, collapsible highlights, Update now / Ignore / Later; progress text while updating |
| Ignoring | Per version: ignoring `v0.2.1-rc.5` stops that prompt only; a newer release is still announced |

Release notes come from the `dsh-v*` releases of `github.com/deepseek-ai/deepseek-harness`
(Chinese sections are parsed; English-only releases show the raw list as-is). When GitHub is
unreachable the update is still announced, with the highlights block left empty.

## How "Update now" works (v1.3.0: stage first, switch locally)

The update has two phases; **the networked install never touches the running installation**:

**Phase 1 — download and verify (DSH keeps serving)**

1. The Host writes a plan and starts a detached `stage-helper.mjs`; it does **not** exit.
2. The helper takes `update.lock` and runs
   `node <npm-cli.js> install -g --no-fund --no-audit --fetch-timeout=60000 --fetch-retries=5 --prefix <isolated dir> @deepseek-ai/dsh@<version>`.
3. Every 15 s it checks whether npm is making progress; **10 minutes without output (45-minute cap)** means
   stalled, and the whole npm process tree is killed with `taskkill /T /F`.
4. It verifies the staged `lib/bin.js`, the `package.json` version, and runs `node bin.js --version`.
   On failure the staging directory is removed — **the live install is untouched and DSH keeps running**.
5. On success `state.json` records `staged: { version, dir }` and the page offers **"Restart & apply"**.

**Phase 2 — switch (~10 seconds, the same shape as the manual rollback)**

1. Clicking "Restart & apply" starts `switch-helper.mjs`; it confirms the old Host exited (otherwise it
   aborts without touching anything).
2. It renames the live install to `dsh.bak-<timestamp>` (kept) and renames the staged `dsh` into place.
3. It starts the new version; the port must answer **continuously for 6 seconds**.
4. If it does not come up, it kills the new process, restores the backup and relaunches the old version.

### Why npm is started as `node + npm-cli.js`, never `npm.cmd`

The update helper is a detached process with no console. Spawning Windows' `npm.cmd` from such a
process fails instantly with `ERROR_NETNAME_DELETED` and npm never runs — that is what broke two real
updates on 2026-11-05, while the very same command works in a normal terminal. Spawning
`node <nodejs>/node_modules/npm/bin/npm-cli.js` with `shell: false` works (`added 616 packages in 1m`).
`npm-invocation.mjs` owns that decision for the Host and both helpers.

Why not install in place any more: on 2026-11-09 a stalled npm run was killed after 15 minutes and the
cleanup/restore hit `EPERM`, leaving DSH half-installed. Staging turns that class of environment failure
into "this update did not happen" instead of "DSH is gone".


Other guards: updates are refused below 1.2 GiB of free space; npm has a 15-minute timeout; the state
file is written atomically (`waiting-host-exit` → `backing-up` → `installing` → `restarting` →
`done` / `rolled-back`); and both surfaces disable their buttons while another update is running.

Logs: `~/.dsh/dsh-update/logs/update-*.log`; state: `~/.dsh/dsh-update/state.json`
(`DSH_HOME` wins when set). Safety regression tests: `node scripts/helper-safety-tests.mjs` — it builds
fake install trees, a fake npm, and fake ports under the system temp directory and never touches a real
DSH installation.

## Install

In DSH Web, open **Settings → Plugins**, add this spec:

```
github:HansyLin-xCoFe/dsh-update-center
```

or use the `plugin_manager` tool / the plugin manager's install entry with the same target. No
`cordis.patch.yml` editing is needed; the plugin appears in Settings → General and at the bottom-left
of the window.

For local development, link this directory (the package root) instead; restart `dsh web` to load a
changed Host half.

Requirements: DSH `>= 0.2.1-rc.2` (Web), Node 18+, and an `npm` that can write to the global prefix.

## Security boundary

- `/dsh-update/*` accepts only **direct loopback**, same-origin requests (`Host` must be
  127.0.0.1 / localhost / [::1]; when `Origin` is present it must match). Everything else gets 403.
- The update action runs one hard-coded global npm install; the client can never pass a command or an
  arbitrary version.
- No session content is read or uploaded. Only the local DSH version, the npm registry, and GitHub
  Releases are read.

## Development

```
plugin/
├─ package.json          # dsh.bundle.patch + dsh.client declaration
├─ cordis.patch.yml      # inserts the Host row
├─ index.js              # Host half: version math, npm/GitHub lookups, ignore state, update plans
├─ client.js             # Client half: General settings row + bottom-left prompt
├─ update-helper.mjs     # detached update helper
├─ npm-invocation.mjs    # how npm is started (node + npm-cli.js, fallback npm.cmd)
├─ locale/{zh,en}.json   # plugin display metadata
└─ icon.svg              # plugin icon
```

No build step: plain ESM and browser JavaScript. Host-half changes need a DSH restart; the Client half
is hot-reloaded by HMR (a page refresh is the safe option). No config is exposed; the update sources are
the `REGISTRY_LATEST_URL` / `RELEASES_URL` constants at the top of `index.js`.

## Changelog

- **1.3.0** (2026-11-09): Updates are now **staged and switched locally**. Download/verify happens in an
  isolated `.dsh-stage-*` directory while DSH keeps running; the page then offers "Restart & apply", and
  the switch is a local rename (~10 s) that falls back to the previous tree on failure. The networked
  install never touches the live installation, so a stalled network, partial tree, or EPERM can only
  mean "this update did not happen". New `stage-helper.mjs`, `switch-helper.mjs`, `update-common.mjs`;
  staged-update regression tests (17 checks).
- **1.2.0** (2026-11-05): Fixed the root cause of "Update now cannot start npm in a console-less
  environment" — `node + npm-cli.js` (`shell: false`) instead of `npm.cmd`, with automatic rewriting of
  legacy `npm.cmd` plans; atomic `state.json` writes; 19 regression tests covering npm invocation, lock
  contention, rollback, and a Host that refuses to exit.
  **Verified on a real machine**: on 2026-11-05 11:57 a click on "Update now" upgraded `0.2.1-rc.4` to
  `0.2.1-rc.5` (`state.json` recorded `phase: done, ok: true`, npm finished in ~40 seconds).
- **1.1.0** (2026-11-05): Safety hardening — single-instance lock, old-process exit check, backup before
  install, automatic rollback on install or startup failure, disk-space check, npm timeout, and the
  "another update is running" UI state. Fixes the incident where two concurrent `npm install -g` runs
  deleted the global installation.
- **1.0.0** (2026-11-03): First release — Settings → General row, bottom-left prompt, update check,
  release highlights, per-version ignore, one-click update.

## Credits

The plugin code, documentation, verification, and release process were produced entirely by
**DeepSeek-V4.1-Flash** and **DeepSeekRuntime**.

Thanks to **@核动力浅水重炮舰** for providing the token — the first publish and the v1.2.0 push were
made with it.

## License

MIT
