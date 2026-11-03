/**
 * dsh-update-center — browser half.
 *
 * Renders two surfaces in the shipped Web GUI:
 *   - a `settings.general.item` row: current version, check button, one-click
 *     update, and the expandable release highlights;
 *   - a `shell.overlay` card at the bottom-left of the frame that asks whether
 *     to update and can be told to ignore that exact version.
 *
 * All host work (npm/GitHub lookups, ignored-version storage, the detached
 * update helper) lives in index.js and is reached through /dsh-update/*.
 */
window.__ModuleLoader__.load({
  id: 'dsh-update-center',
  factory(require) {
    const React = require('react');
    const { useEffect, useSyncExternalStore } = React;
    const h = React.createElement;

    const NS = 'dsh-update';
    const ENDPOINT = '/dsh-update';
    const STYLE_ID = 'dsh-update-center/styles';
    const POLL_INTERVAL_MS = 4000;
    const POLL_LIMIT_MS = 6 * 60 * 1000;

    /* -------------------- dictionaries -------------------- */

    const zh = {
      'row.title': 'DSH 更新',
      'row.current': '当前版本 v{version}',
      'row.latest': '最新版本 v{version}',
      'row.upToDate': '已是最新版本',
      'row.unknownCurrent': '当前版本未知',
      'row.check': '检查更新',
      'row.checking': '正在检查…',
      'row.update': '一键更新',
      'row.updateBusy': '正在更新…',
      'row.ignore': '忽略此版本',
      'row.unignore': '取消忽略',
      'row.ignored': '已忽略 v{version}',
      'row.notes': '更新重点',
      'row.notesHide': '收起更新重点',
      'row.applying': '正在下载并安装更新，DSH 会重启，页面将自动重连…',
      'row.applied': '已更新到 v{version}，刷新页面后即可使用新版本。',
      'row.reload': '刷新页面',
      'row.checkError': '检查更新失败：{message}',
      'row.applyError': '更新操作失败：{message}',
      'row.lastFailed': '上次更新（v{version}）未完成：{message}',
      'row.lastOk': '上次更新（v{version}）已完成。',
      'row.log': '日志：{path}',
      'prompt.aria': 'DSH 更新提示',
      'prompt.title': '发现新版本 v{version}',
      'prompt.titleApplying': '正在更新 DSH…',
      'prompt.titleApplied': '更新已完成',
      'prompt.line': '当前 v{current}{extra}',
      'prompt.multi': '，共 {count} 个版本可更新',
      'prompt.notes': '更新重点',
      'prompt.notesHide': '收起更新重点',
      'prompt.update': '立即更新',
      'prompt.ignore': '忽略此版本',
      'prompt.later': '稍后',
      'prompt.close': '关闭',
      'prompt.applying': '正在下载并安装更新，DSH 会重启，页面将自动重连…',
      'prompt.applied': '已更新到 v{version}，刷新页面即可使用新版本。',
      'prompt.reload': '刷新页面',
      'prompt.error': '更新未能启动：{message}',
      'prompt.ignored': '已忽略 v{version}',
      'notes.empty': '该版本没有提供更新说明。',
      'notes.release': 'v{version}',
      'notes.published': '{date}',
      'notes.more': '{count} 项变更',
      'notes.source': '更新说明来源：GitHub Releases',
      'common.unknown': '未知',
    };

    const en = {
      'row.title': 'DSH Update',
      'row.current': 'Current version v{version}',
      'row.latest': 'Latest version v{version}',
      'row.upToDate': 'Up to date',
      'row.unknownCurrent': 'Current version unknown',
      'row.check': 'Check for updates',
      'row.checking': 'Checking…',
      'row.update': 'Update now',
      'row.updateBusy': 'Updating…',
      'row.ignore': 'Ignore this version',
      'row.unignore': 'Stop ignoring',
      'row.ignored': 'Ignoring v{version}',
      'row.notes': 'Release highlights',
      'row.notesHide': 'Hide release highlights',
      'row.applying': 'Downloading and installing the update. DSH will restart and this page reconnects automatically…',
      'row.applied': 'Updated to v{version}. Reload the page to use the new version.',
      'row.reload': 'Reload page',
      'row.checkError': 'Could not check for updates: {message}',
      'row.applyError': 'Update failed: {message}',
      'row.lastFailed': 'The previous update (v{version}) did not finish: {message}',
      'row.lastOk': 'The previous update (v{version}) finished.',
      'row.log': 'Log: {path}',
      'prompt.aria': 'DSH update notice',
      'prompt.title': 'New version v{version} available',
      'prompt.titleApplying': 'Updating DSH…',
      'prompt.titleApplied': 'Update finished',
      'prompt.line': 'Current v{current}{extra}',
      'prompt.multi': ', {count} versions behind',
      'prompt.notes': 'Release highlights',
      'prompt.notesHide': 'Hide release highlights',
      'prompt.update': 'Update now',
      'prompt.ignore': 'Ignore this version',
      'prompt.later': 'Later',
      'prompt.close': 'Close',
      'prompt.applying': 'Downloading and installing the update. DSH will restart and this page reconnects automatically…',
      'prompt.applied': 'Updated to v{version}. Reload the page to use the new version.',
      'prompt.reload': 'Reload page',
      'prompt.error': 'Could not start the update: {message}',
      'prompt.ignored': 'Ignoring v{version}',
      'notes.empty': 'This version did not publish release notes.',
      'notes.release': 'v{version}',
      'notes.published': '{date}',
      'notes.more': '{count} changes',
      'notes.source': 'Release notes: GitHub Releases',
      'common.unknown': 'Unknown',
    };

    /* -------------------- styles -------------------- */

    const CSS = `
.dsu-row{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsu-row-main{min-width:0;flex:1}
.dsu-row-title{font-size:14px;line-height:20px}
.dsu-row-desc{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsu-row-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;padding-top:2px}
.dsu-btn{height:28px;padding:0 12px;border-radius:8px;border:1px solid transparent;font:inherit;font-size:12px;line-height:26px;cursor:pointer;white-space:nowrap;transition:background .15s ease,border-color .15s ease,filter .15s ease}
.dsu-btn:disabled{opacity:.55;cursor:default}
.dsu-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff}
.dsu-btn-primary:not(:disabled):hover{filter:brightness(1.08)}
.dsu-btn-secondary{background:transparent;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsu-btn-secondary:not(:disabled):hover{background:var(--dsw-alias-bg-layer-2)}
.dsu-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:0 4px}
.dsu-btn-ghost:not(:disabled):hover{color:var(--dsw-alias-label-primary)}
.dsu-toggle{display:inline-flex;align-items:center;gap:4px;margin-top:8px;padding:0;border:0;background:none;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsu-toggle:hover{color:var(--dsw-alias-label-primary)}
.dsu-chevron{transition:transform .15s ease;flex-shrink:0}
.dsu-chevron-open{transform:rotate(90deg)}
.dsu-hint{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsu-hint-success{color:var(--dsw-alias-state-success-primary)}
.dsu-alert{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dsu-log{margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}
.dsu-link{padding:0;margin-left:6px;border:0;background:none;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer}
.dsu-link:disabled{opacity:.55;cursor:default}
.dsu-notes{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);max-height:260px;overflow:auto}
.dsu-release+.dsu-release{margin-top:12px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l1)}
.dsu-release-head{display:flex;align-items:baseline;gap:8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsu-release-name{font-family:var(--ds-font-family-code,ui-monospace,monospace)}
.dsu-release-date{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsu-section{margin-top:6px}
.dsu-section-head{font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsu-item{position:relative;margin-top:3px;padding-left:12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsu-item:before{content:"";position:absolute;left:2px;top:7px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-label-secondary)}
.dsu-notes-empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsu-notes-source{margin-top:8px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsu-prompt{position:absolute;left:16px;bottom:16px;z-index:1;width:340px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:14px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 12px 32px rgba(0,0,0,.18);font-size:13px;line-height:20px}
.dsu-prompt-head{display:flex;align-items:flex-start;gap:8px}
.dsu-prompt-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;background:var(--dsw-alias-brand-primary);flex-shrink:0}
.dsu-prompt-titles{min-width:0;flex:1}
.dsu-prompt-title{font-size:13px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.dsu-prompt-sub{margin-top:2px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsu-close{flex-shrink:0;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:16px;line-height:22px;cursor:pointer}
.dsu-close:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsu-prompt-actions{display:flex;align-items:center;gap:8px;margin-top:12px}
.dsu-prompt-actions .dsu-spacer{flex:1}
.dsu-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:8px}
@media (prefers-reduced-motion:reduce){.dsu-btn,.dsu-chevron{transition:none}}
`;

    function installStyles() {
      const previous = document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`);
      if (previous !== null) previous.remove();
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-update-center';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    /* -------------------- helpers -------------------- */

    function errorMessage(error) {
      if (error instanceof Error && error.message !== '') return error.message;
      return String(error);
    }

    const dateFormatter = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    function formatDate(iso) {
      if (typeof iso !== 'string' || iso === '') return '';
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return dateFormatter.format(date);
    }

    function Chevron({ open }) {
      return h(
        'svg',
        {
          className: 'dsu-chevron' + (open ? ' dsu-chevron-open' : ''),
          width: 12,
          height: 12,
          viewBox: '0 0 12 12',
          'aria-hidden': true,
        },
        h('path', {
          d: 'M4 2.5 8 6l-4 3.5',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function ReleaseNotes({ t, releases }) {
      if (!Array.isArray(releases) || releases.length === 0) {
        return h('div', { className: 'dsu-notes-empty' }, t('notes.empty'));
      }
      return h(
        'div',
        { className: 'dsu-notes' },
        releases.map((release) => {
          const date = formatDate(release.publishedAt);
          const sections = Array.isArray(release.sections) ? release.sections : [];
          const changes = sections.reduce(
            (total, section) => total + (Array.isArray(section.items) ? section.items.length : 0),
            0,
          );
          return h(
            'div',
            { className: 'dsu-release', key: release.version },
            h(
              'div',
              { className: 'dsu-release-head' },
              h('span', { className: 'dsu-release-name' }, t('notes.release', { version: release.version })),
              date !== '' ? h('span', { className: 'dsu-release-date' }, t('notes.published', { date })) : null,
              changes > 0 ? h('span', { className: 'dsu-release-date' }, t('notes.more', { count: changes })) : null,
            ),
            sections.length === 0
              ? h('div', { className: 'dsu-notes-empty' }, t('notes.empty'))
              : sections.map((section, sectionIndex) =>
                  h(
                    'div',
                    { className: 'dsu-section', key: sectionIndex },
                    section.heading !== ''
                      ? h('div', { className: 'dsu-section-head' }, section.heading)
                      : null,
                    (Array.isArray(section.items) ? section.items : []).map((item, itemIndex) =>
                      h('div', { className: 'dsu-item', key: itemIndex }, item),
                    ),
                  ),
                ),
          );
        }),
      );
    }

    /* -------------------- store -------------------- */

    function createStore() {
      let state = {
        phase: 'idle',
        status: null,
        error: null,
        applyError: null,
        applyLog: null,
        applying: false,
        applied: false,
        dismissed: false,
        notesOpen: false,
        rowNotesOpen: false,
        ignoreBusy: false,
      };
      const listeners = new Set();
      let inflight = null;
      let pollTimer = null;
      let disposed = false;

      const emit = () => {
        for (const listener of listeners) {
          try {
            listener();
          } catch {
            /* one broken subscriber must not blank the others */
          }
        }
      };

      const set = (patch) => {
        state = { ...state, ...patch };
        emit();
      };

      const request = async (path, init) => {
        const response = await fetch(path, { cache: 'no-store', ...(init ?? {}) });
        let data = {};
        try {
          data = await response.json();
        } catch {
          data = {};
        }
        if (!response.ok) {
          throw new Error(data && data.error ? data.error : 'HTTP ' + response.status);
        }
        return data;
      };

      const stopPoll = () => {
        if (pollTimer !== null) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      };

      const store = {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },

        async refresh(force) {
          if (inflight !== null) return inflight;
          set({ phase: state.status === null ? 'loading' : 'refreshing', error: null });
          inflight = (async () => {
            try {
              const data = await request(ENDPOINT + '/status' + (force ? '?refresh=1' : ''));
              if (disposed) return;
              set({ status: data, phase: 'ready', error: null });
              if (!data.updateAvailable && !state.applying) set({ notesOpen: false });
            } catch (error) {
              if (!disposed) set({ phase: 'error', error: errorMessage(error) });
            } finally {
              inflight = null;
            }
          })();
          return inflight;
        },

        async setIgnored(version) {
          set({ ignoreBusy: true, applyError: null });
          try {
            await request(ENDPOINT + '/ignore', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ version }),
            });
            await store.refresh(false);
            if (version !== null) set({ dismissed: true });
          } catch (error) {
            set({ applyError: errorMessage(error) });
          } finally {
            set({ ignoreBusy: false });
          }
        },

        async applyUpdate() {
          if (state.applying) return;
          set({ applying: true, applied: false, dismissed: false, applyError: null, error: null });
          try {
            const data = await request(ENDPOINT + '/apply', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({}),
            });
            set({ applyLog: data.logPath ?? null });
            store.startPoll();
          } catch (error) {
            set({ applying: false, applyError: errorMessage(error) });
          }
        },

        startPoll() {
          stopPoll();
          const startedAt = Date.now();
          pollTimer = setInterval(async () => {
            if (disposed) {
              stopPoll();
              return;
            }
            if (Date.now() - startedAt > POLL_LIMIT_MS) {
              stopPoll();
              return;
            }
            try {
              const data = await request(ENDPOINT + '/status');
              if (disposed) return;
              set({ status: data, phase: 'ready', error: null });
              if (data.updateAvailable === false && data.current !== null && data.current === data.latest) {
                stopPoll();
                set({ applying: false, applied: true });
              }
            } catch {
              /* the host is restarting; keep waiting */
            }
          }, POLL_INTERVAL_MS);
        },

        toggleNotes(which) {
          if (which === 'row') set({ rowNotesOpen: !state.rowNotesOpen });
          else set({ notesOpen: !state.notesOpen });
        },

        dismiss() {
          set({ dismissed: true });
        },

        dispose() {
          disposed = true;
          stopPoll();
          listeners.clear();
        },
      };

      return store;
    }

    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.get);
    }

    /* -------------------- settings row -------------------- */

    function SettingsRow({ t, store }) {
      const state = useStore(store);
      const status = state.status;
      const current = status ? status.current : null;
      const latest = status ? status.latest : null;
      const updateAvailable = Boolean(status && status.updateAvailable);
      const ignored = Boolean(status && status.ignored);
      const checking = state.phase === 'loading' || state.phase === 'refreshing';
      const applying = state.applying;
      const applied = state.applied;
      const releases = status && Array.isArray(status.pending) ? status.pending : [];
      const lastUpdate = status ? status.lastUpdate : null;
      const notesOpen = state.rowNotesOpen;

      const description = [];
      description.push(
        current !== null ? t('row.current', { version: current }) : t('row.unknownCurrent'),
      );
      if (latest !== null && current !== null) {
        description.push(
          updateAvailable ? t('row.latest', { version: latest }) : t('row.upToDate'),
        );
      }

      const children = [
        h(
          'div',
          { className: 'dsu-row-main', key: 'main' },
          h('div', { className: 'dsu-row-title' }, t('row.title')),
          h('div', { className: 'dsu-row-desc' }, description.join(' · ')),
          updateAvailable && releases.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsu-toggle',
                  'aria-expanded': notesOpen,
                  onClick: () => store.toggleNotes('row'),
                  key: 'notes-toggle',
                },
                h(Chevron, { open: notesOpen }),
                h('span', null, notesOpen ? t('row.notesHide') : t('row.notes')),
              )
            : null,
          notesOpen ? h(ReleaseNotes, { t, releases, key: 'notes' }) : null,
          ignored && latest !== null
            ? h(
                'div',
                { className: 'dsu-hint', key: 'ignored' },
                h('span', null, t('row.ignored', { version: latest })),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsu-link',
                    disabled: state.ignoreBusy,
                    onClick: () => store.setIgnored(null),
                  },
                  t('row.unignore'),
                ),
              )
            : null,
          applying ? h('div', { className: 'dsu-hint', key: 'applying' }, t('row.applying')) : null,
          applied
            ? h(
                'div',
                { className: 'dsu-hint dsu-hint-success', key: 'applied' },
                t('row.applied', { version: latest !== null ? latest : current !== null ? current : '' }),
              )
            : null,
          state.error !== null
            ? h(
                'div',
                { className: 'dsu-alert', role: 'alert', key: 'check-error' },
                t('row.checkError', { message: state.error }),
              )
            : null,
          state.applyError !== null
            ? h(
                'div',
                { className: 'dsu-alert', role: 'alert', key: 'apply-error' },
                t('row.applyError', { message: state.applyError }),
              )
            : null,
          lastUpdate !== null && lastUpdate.ok === false
            ? h(
                'div',
                { className: 'dsu-alert', role: 'alert', key: 'last-failed' },
                t('row.lastFailed', {
                  version: lastUpdate.version ?? '',
                  message: lastUpdate.error ?? '',
                }),
                lastUpdate.logPath ? h('div', { className: 'dsu-log' }, t('row.log', { path: lastUpdate.logPath })) : null,
              )
            : null,
          lastUpdate !== null && lastUpdate.ok === true && !applying
            ? h(
                'div',
                { className: 'dsu-hint', key: 'last-ok' },
                t('row.lastOk', { version: lastUpdate.version ?? '' }),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsu-row-actions', key: 'actions' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsu-btn dsu-btn-secondary',
              disabled: checking || applying,
              onClick: () => store.refresh(true),
            },
            checking ? t('row.checking') : t('row.check'),
          ),
          updateAvailable && !ignored
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsu-btn dsu-btn-ghost',
                  disabled: applying || state.ignoreBusy,
                  onClick: () => store.setIgnored(latest),
                },
                t('row.ignore'),
              )
            : null,
          applied
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsu-btn dsu-btn-primary',
                  onClick: () => globalThis.location.reload(),
                },
                t('row.reload'),
              )
            : updateAvailable
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsu-btn dsu-btn-primary',
                    disabled: applying,
                    onClick: () => store.applyUpdate(),
                  },
                  applying ? t('row.updateBusy') : t('row.update'),
                )
              : null,
        ),
      ];

      return h('div', { className: 'dsu-row' }, children);
    }

    /* -------------------- bottom-left prompt -------------------- */

    function UpdatePrompt({ t, store }) {
      const state = useStore(store);
      const status = state.status;
      if (status === null) return null;
      const latest = status.latest;
      if (latest === null) return null;
      const current = status.current;
      const updateAvailable = Boolean(status.updateAvailable);
      const ignored = Boolean(status.ignored);
      const applying = state.applying;
      const applied = state.applied;
      const visible = !state.dismissed && ((updateAvailable && !ignored) || applying || applied);
      if (!visible) return null;

      const releases = Array.isArray(status.pending) ? status.pending : [];
      const notesOpen = state.notesOpen;
      const extra =
        !applying && !applied && releases.length > 1
          ? t('prompt.multi', { count: releases.length })
          : '';

      const actions = [];
      if (applying) {
        /* Nothing to click while the update helper runs. */
      } else if (applied) {
        actions.push(
          h(
            'button',
            {
              type: 'button',
              className: 'dsu-btn dsu-btn-primary',
              onClick: () => globalThis.location.reload(),
              key: 'reload',
            },
            t('prompt.reload'),
          ),
        );
      } else {
        actions.push(
          h(
            'button',
            {
              type: 'button',
              className: 'dsu-btn dsu-btn-secondary',
              onClick: () => store.dismiss(),
              key: 'later',
            },
            t('prompt.later'),
          ),
          h('span', { className: 'dsu-spacer', key: 'spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsu-btn dsu-btn-ghost',
              disabled: state.ignoreBusy,
              onClick: () => store.setIgnored(latest),
              key: 'ignore',
            },
            t('prompt.ignore'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsu-btn dsu-btn-primary',
              onClick: () => store.applyUpdate(),
              key: 'update',
            },
            t('prompt.update'),
          ),
        );
      }

      const body = [];
      body.push(
        h(
          'div',
          { className: 'dsu-prompt-head', key: 'head' },
          h('span', { className: 'dsu-prompt-dot' }),
          h(
            'div',
            { className: 'dsu-prompt-titles' },
            h(
              'div',
              { className: 'dsu-prompt-title' },
              applying
                ? t('prompt.titleApplying')
                : applied
                  ? t('prompt.titleApplied')
                  : t('prompt.title', { version: latest }),
            ),
            !applying && !applied
              ? h(
                  'div',
                  { className: 'dsu-prompt-sub' },
                  t('prompt.line', { current: current !== null ? current : t('common.unknown'), extra }),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsu-close',
              'aria-label': t('prompt.close'),
              onClick: () => store.dismiss(),
            },
            '\u00d7',
          ),
        ),
      );

      if (applying) {
        body.push(
          h('div', { className: 'dsu-muted', key: 'applying' }, t('prompt.applying')),
          state.applyLog
            ? h('div', { className: 'dsu-log', key: 'log' }, t('row.log', { path: state.applyLog }))
            : null,
        );
      } else if (!applied && updateAvailable) {
        if (releases.length > 0) {
          body.push(
            h(
              'button',
              {
                type: 'button',
                className: 'dsu-toggle',
                'aria-expanded': notesOpen,
                onClick: () => store.toggleNotes('overlay'),
                key: 'notes-toggle',
              },
              h(Chevron, { open: notesOpen }),
              h('span', null, notesOpen ? t('prompt.notesHide') : t('prompt.notes')),
            ),
            notesOpen ? h(ReleaseNotes, { t, releases, key: 'notes' }) : null,
          );
        }
      }

      if (state.applyError !== null) {
        body.push(
          h(
            'div',
            { className: 'dsu-alert', role: 'alert', key: 'apply-error' },
            t('prompt.error', { message: state.applyError }),
          ),
        );
      }

      body.push(h('div', { className: 'dsu-prompt-actions', key: 'actions' }, actions));

      return h(
        'section',
        { className: 'dsu-prompt', role: 'region', 'aria-label': t('prompt.aria') },
        body,
      );
    }

    /* -------------------- plugin wiring -------------------- */

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(installStyles, 'dsh-update-center: styles');
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-update-center: dictionaries');

      const t = ctx.locale.bind(NS);
      const store = createStore();
      ctx.effect(() => () => store.dispose(), 'dsh-update-center: store');

      ctx.slots.inject('settings.general.item', () =>
        ctx.slots.register(
          {
            name: 'settings.general.item',
            id: 'dsh-update',
            order: 101,
            locale: NS,
            inject: () => ({ t, store }),
          },
          SettingsRow,
        ),
      );

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'dsh-update-prompt',
            locale: NS,
            inject: () => ({ t, store }),
          },
          UpdatePrompt,
        ),
      );

      /* Check once whenever this page boots, as asked: "每次打开DSH检测最新版本". */
      store.refresh(true);
    }

    return { name: 'dsh-update-center', inject, apply };
  },
});
