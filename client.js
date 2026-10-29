window.__ModuleLoader__.load({
  id: '@estelle-ge/dsh-plugin-session-cleaner',
  factory(require) {
    const React = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const h = React.createElement;

    /** React 18 root factory (baseline external); needed only for the DOM-augmented workspace menu row. */
    let createRoot;
    try {
      const client = require('react-dom/client');
      if (client !== null && typeof client.createRoot === 'function') createRoot = client.createRoot;
    } catch {
      createRoot = undefined;
    }
    if (createRoot === undefined && typeof ReactDOM.createRoot === 'function') createRoot = ReactDOM.createRoot;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'sessionCleaner';

    /** Stable error-code -> dictionary key mapping shared by the dialog. */
    const ERROR_KEYS = {
      'session/invalid': 'error.invalid',
      'session/not-found': 'error.notFound',
      'session/live': 'error.live',
      'session/active': 'error.active',
      'workspace/refused': 'error.workspace',
      'delete/failed': 'error.failed',
    };

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'menu.delete': '删除会话',
      'archive.show': '显示归档会话',
      'archive.hide': '隐藏归档会话',
      'archive.label': '归档会话',
      'delete.title': '删除会话？',
      'delete.desc': '“{title}”及其全部历史记录将从磁盘永久删除，无法撤销。',
      'delete.note': '删除后，该会话不再出现在侧栏、工作区与搜索结果中。',
      'delete.confirm': '删除',
      'delete.cancel': '取消',
      'delete.close': '关闭',
      'delete.pending': '正在删除…',
      'delete.done': '会话已删除',
      'delete.failed': '删除失败：{message}',
      'error.invalid': '会话 ID 无效，无法删除。',
      'error.notFound': '会话不存在或已被删除。',
      'error.live': '该会话当前无法删除，请稍后重试或重启 DSH。',
      'error.active': '该会话仍在运行：宿主已尝试停止，但未能在限定时间内停止，未删除任何内容。请先停止该会话的工作后重试。',
      'error.workspace': '无法从工作区移除该会话，删除已中止。',
      'error.failed': '删除会话失败：{message}',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'menu.delete': 'Delete session',
      'archive.show': 'Show archived sessions',
      'archive.hide': 'Hide archived sessions',
      'archive.label': 'Archived sessions',
      'delete.title': 'Delete this session?',
      'delete.desc': '“{title}” and its entire history will be permanently removed from disk. This cannot be undone.',
      'delete.note': 'After deletion the session disappears from the sidebar, its workspace and search results.',
      'delete.confirm': 'Delete',
      'delete.cancel': 'Cancel',
      'delete.close': 'Close',
      'delete.pending': 'Deleting…',
      'delete.done': 'Session deleted',
      'delete.failed': 'Delete failed: {message}',
      'error.invalid': 'The session id is invalid, so it cannot be deleted.',
      'error.notFound': 'The session does not exist or was already deleted.',
      'error.live': 'This session cannot be deleted right now; retry later or restart DSH.',
      'error.active': 'This session is still running: the host tried to stop it but it did not stop in time, so nothing was deleted. Stop its work and retry.',
      'error.workspace': 'The session could not be detached from its workspace; deletion was aborted.',
      'error.failed': 'Deleting the session failed: {message}',
    };

    /** Persisted global archived-session visibility ('1' = shown, '0'/absent = hidden). */
    const STORAGE_KEY = 'dsh.session-cleaner.archived-visible';
    /** Pre-switch per-workspace state; removed on load so the old toggle cannot resurface. */
    const LEGACY_STORAGE_KEY = 'dsh.session-cleaner.workspace-archived';
    /** Plugin-owned row marker: this archived session row must stay hidden. */
    const HIDDEN_ATTR = 'data-session-cleaner-archived-hidden';
    /** Plugin-owned root marker: hide archived rows until the controller classifies them. */
    const GUARD_ATTR = 'data-session-cleaner-archived-guard';
    /** Plugin-owned marker on the injected sidebar switch container. */
    const TOGGLE_ATTR = 'data-session-cleaner-archive-toggle';

    /** Plugin-local stylesheet; only the surfaces the primitives do not style. */
    const CSS = [
      '.spc-dialog-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0 0 8px}',
      '.spc-dialog-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-wrap}',
      '.spc-dialog-warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));font-size:12px;line-height:18px;margin-top:8px}',
      '.spc-dialog-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // Archived-session hiding: a plugin-owned attribute plus `!important`
      // CSS, so a React re-render (which only reconciles props it owns) can
      // never wipe it the way an inline `style.display` could.
      `[${HIDDEN_ATTR}]{display:none !important}`,
      // Flash guard: an archived row is hidden from the moment it renders until
      // the controller has classified it (new rows never appear before tagging).
      `html[${GUARD_ATTR}="all"] [data-row-key^="session:"][aria-description]{display:none !important}`,
      // Sidebar switch row: inherits the official panel-row classes captured from
      // the live sidebar; these rules only add the label fallback and the pill.
      '.spc-archive-row{display:flex;width:100%}',
      '.spc-archive-title{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.spc-archive-switch{flex:none;margin-left:auto;width:28px;height:16px;border-radius:999px;background:var(--dsw-alias-interactive-bg-secondary,rgba(120,120,120,.28));position:relative;transition:background .15s var(--ds-ease-in-out, ease)}',
      '.spc-archive-switch.spc-on{background:var(--dsw-alias-state-business-primary,#2f6bff)}',
      '.spc-archive-knob{position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s var(--ds-ease-in-out, ease)}',
      '.spc-archive-switch.spc-on .spc-archive-knob{transform:translateX(12px)}',
      '.spc-archive-compact .spc-archive-title,.spc-archive-compact .spc-archive-switch{display:none !important}',
      '.spc-archive-compact .spc-archive-row{justify-content:center}',
    ].join('');

    // ────────────────────────────── tiny store ──────────────────────────────

    /**
     * Minimal snapshot store (getSnapshot/subscribe/set) used as an observable
     * source for slot `hooks` and for component state.
     * @param initial - initial value.
     * @returns observable snapshot store.
     */
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(next) {
          value = next;
          for (const listener of [...listeners]) {
            try {
              listener();
            } catch (error) {
              console.error('[session-cleaner] store listener failed:', error);
            }
          }
        },
      };
    }

    // ─────────────────────────── host endpoint client ───────────────────────

    /**
     * Call the authenticated host delete route. Never throws for transport or
     * business failures; the caller decides how to present the code.
     * @param sessionId - stored Session identity.
     * @returns `{ ok: true }` or `{ ok: false, code, message }`.
     */
    async function callDeleteSession(sessionId) {
      let response;
      try {
        response = await fetch('/api/session-cleaner/delete', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        });
      } catch (error) {
        return { ok: false, code: 'delete/failed', message: error instanceof Error ? error.message : String(error) };
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = undefined;
      }
      if (response.ok && payload !== null && typeof payload === 'object' && payload.ok === true) return { ok: true };
      const error = payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object' ? payload.error : undefined;
      const code = error !== undefined && typeof error.code === 'string' ? error.code : response.ok ? 'delete/failed' : `http/${response.status}`;
      const message = error !== undefined && typeof error.message === 'string' ? error.message : `HTTP ${response.status}`;
      return { ok: false, code, message };
    }

    // ──────────────────────── feature 1 · delete session ────────────────────

    /**
     * One row in the session "..." menu. Dismisses the owner menu through the
     * slot-level hook before raising the shared confirmation request.
     * @param props - row identity, menu-open hook, injected request callback, t.
     * @returns the destructive menu row.
     */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      return h(
        primitives.MenuItemButton,
        {
          danger: true,
          separatorBefore: true,
          icon: h(primitives.IconTrashOutlineRegular, { size: 16 }),
          onSelect: () => {
            setMenuOpen(false);
            requestDelete(sessionId, displayTitle === undefined || displayTitle === null ? '' : String(displayTitle));
          },
        },
        t('menu.delete'),
      );
    }

    /**
     * Confirmation modal plus result toast, mounted once in the shell overlay.
     * @param props - injected request/toast hooks and behavior callbacks.
     * @returns portal tree or null.
     */
    function DeleteSessionOverlay({ useRequest, useToast, dismissToast, cancelDelete, confirmDelete, t }) {
      const request = useRequest((pending) => pending);
      const toast = useToast((current) => current);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        setBusy(false);
        setError(null);
      }, [request === null ? null : request.seq]);

      const close = () => {
        if (busy) return;
        cancelDelete();
      };

      const modal =
        request === null
          ? null
          : h(
              primitives.Modal,
              {
                open: true,
                onClose: close,
                closeLabel: t('delete.close'),
                title: t('delete.title'),
                description: t('delete.desc', { title: request.displayTitle === '' ? request.sessionId : request.displayTitle }),
                footer: [
                  h(
                    primitives.Button,
                    { key: 'cancel', variant: 'outline', disabled: busy, onClick: close, 'data-modal-autofocus': true },
                    t('delete.cancel'),
                  ),
                  h(
                    primitives.Button,
                    {
                      key: 'confirm',
                      variant: 'outline',
                      danger: true,
                      disabled: busy,
                      onClick: () => {
                        if (busy) return;
                        setBusy(true);
                        setError(null);
                        Promise.resolve()
                          .then(() => confirmDelete(request))
                          .then((result) => {
                            if (result !== undefined && result !== null && result.ok === false) {
                              setError(messageForCode(result, t));
                              return;
                            }
                            cancelDelete();
                          })
                          .catch((reason) => {
                            setError(t('delete.failed', { message: reason instanceof Error ? reason.message : String(reason) }));
                          })
                          .finally(() => {
                            setBusy(false);
                          });
                      },
                    },
                    t('delete.confirm'),
                  ),
                ],
              },
              h('p', { className: 'spc-dialog-note' }, t('delete.note')),
              busy ? h('p', { className: 'spc-dialog-status', role: 'status' }, t('delete.pending')) : null,
              error === null ? null : h('p', { className: 'spc-dialog-error', role: 'alert' }, error),
            );

      const banner =
        toast === null
          ? null
          : h(primitives.Toast, {
              key: toast.seq,
              text: toast.text,
              tone: toast.tone,
              holdMs: 3200,
              onDone: dismissToast,
            });

      if (modal === null && banner === null) return null;
      return h(React.Fragment, null, modal, banner);
    }

    /**
     * Localize one host failure result.
     * @param result - `{ ok:false, code, message }` from the host route.
     * @param t - namespace translate function.
     * @returns user-facing text.
     */
    function messageForCode(result, t) {
      const key = typeof result.code === 'string' ? ERROR_KEYS[result.code] : undefined;
      if (key === 'error.failed') return t(key, { message: result.message === undefined ? '' : result.message });
      if (key !== undefined) return t(key);
      return t('delete.failed', { message: result.message === undefined ? '' : result.message });
    }

    // ───────────────── feature 2 · global archived visibility ──────────────

    /**
     * Check whether an element carries a CSS-module class token ending in
     * `suffix` (the build prefixes tokens, so suffix matching is the stable
     * contract).
     * @param element - candidate element.
     * @param suffix - token suffix such as `_archived`.
     * @returns true when any class token matches.
     */
    function hasClassSuffix(element, suffix) {
      if (element === null || element === undefined) return false;
      const className = element.getAttribute('class');
      if (className === null) return false;
      return className.split(/\s+/).some((token) => token === suffix || token.endsWith(suffix));
    }

    /**
     * Locate the live WorkspaceBrowser viewing actions through the React fiber
     * attached to a sidebar row. The component receives its store actions as
     * props, which is the only public-ish way to change the archived filter from
     * a plugin. Returns undefined when React internals are unavailable.
     * @returns `{ setArchivedFilter(filter) }` when found.
     */
    function findWorkspaceViewActions() {
      const row =
        document.querySelector('[data-row-key^="session:"]') ??
        document.querySelector('[data-row-key^="workspace:"]') ??
        document.querySelector('[data-row-key^="overflow:"]');
      if (row === null) return undefined;
      const fiberKey = Object.keys(row).find((key) => key.startsWith('__reactFiber$'));
      if (fiberKey === undefined) return undefined;
      let fiber = row[fiberKey];
      let guard = 0;
      while (fiber !== null && fiber !== undefined && guard < 400) {
        const props = fiber.memoizedProps;
        const actions = props !== null && typeof props === 'object' ? props.actions : undefined;
        if (actions !== null && typeof actions === 'object' && typeof actions.setArchivedFilter === 'function') return actions;
        fiber = fiber.return;
        guard += 1;
      }
      return undefined;
    }

    /**
     * Workspace-domain labels for the built-in archived-filter menu, resolved
     * from the `workspace` dictionary so the fallback follows the locale.
     * @param ctx - client root context.
     * @returns resolver for the view-option strings.
     */
    function viewOptionLabels(ctx) {
      const fallback = (key) => {
        switch (key) {
          case 'viewOptions.label':
            return '视图选项';
          case 'viewOptions.showArchived':
            return '全部对话（显示已归档）';
          case 'viewOptions.hideArchived':
            return '隐藏已归档';
          case 'viewOptions.onlyArchived':
            return '仅显示已归档';
          default:
            return key;
        }
      };
      let translate;
      try {
        translate = ctx.locale.bind('workspace');
      } catch {
        translate = undefined;
      }
      return (key) => {
        try {
          const value = translate === undefined ? key : translate(key);
          if (typeof value !== 'string' || value === key) return fallback(key);
          return value;
        } catch {
          return fallback(key);
        }
      };
    }

    /** Read the persisted global visibility; only an explicit '1' means shown. */
    function loadArchiveVisible() {
      try {
        return window.localStorage.getItem(STORAGE_KEY) === '1';
      } catch {
        return false;
      }
    }

    /** Persist the global visibility and drop the legacy per-workspace record. */
    function persistArchiveVisible(visible) {
      try {
        window.localStorage.setItem(STORAGE_KEY, visible ? '1' : '0');
        window.localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* storage may be unavailable in hardened contexts; state stays in memory */
      }
    }

    /** @returns the app's persisted archived filter ('default' | 'show' | 'only'). */
    function readArchivedFilter() {
      try {
        const raw = window.localStorage.getItem('dsh.workspace.view.v5');
        if (raw === null || raw === '') return undefined;
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === 'object' && typeof parsed.archivedFilter === 'string' ? parsed.archivedFilter : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * Sidebar switch component. One click flips the single global state; the
     * switch itself renders `aria-checked` plus a pill so the state is visible
     * at a glance and in the collapsed rail.
     * @param props - visibility, captured sidebar classes, localized labels, toggle callback.
     * @returns the switch row button.
     */
    function ArchiveVisibilitySwitch({ visible, classes, labelShow, labelHide, onToggle }) {
      const action = visible ? labelHide : labelShow;
      const rowClasses = [classes.rowClass, 'spc-archive-row'].filter((value) => typeof value === 'string' && value.length > 0).join(' ');
      const titleClasses = [classes.titleClass, 'spc-archive-title'].filter((value) => typeof value === 'string' && value.length > 0).join(' ');
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': visible ? 'true' : 'false',
          'aria-label': action,
          title: action,
          className: rowClasses,
          onClick: onToggle,
        },
        h(
          'span',
          { className: classes.glyphClass === undefined ? '' : classes.glyphClass, 'aria-hidden': 'true' },
          h(visible ? primitives.IconArchiveCheckOutlineRegular : primitives.IconArchiveOutlineRegular, { size: 16 }),
        ),
        h('span', { className: titleClasses }, action),
        h(
          'span',
          { className: visible ? 'spc-archive-switch spc-on' : 'spc-archive-switch', 'aria-hidden': 'true' },
          h('span', { className: 'spc-archive-knob' }),
        ),
      );
    }

    /**
     * Host component of the injected switch row.
     * @param props - controller providing the two observable stores and the toggle.
     * @returns the switch component subscribed to visibility + layout.
     */
    function ArchiveVisibilityHost({ controller }) {
      const [visible, setVisible] = React.useState(controller.visibility.getSnapshot());
      const [classes, setClasses] = React.useState(controller.layout.getSnapshot());
      React.useEffect(() => {
        const offVisibility = controller.visibility.subscribe(() => setVisible(controller.visibility.getSnapshot()));
        const offLayout = controller.layout.subscribe(() => setClasses(controller.layout.getSnapshot()));
        return () => {
          offVisibility();
          offLayout();
        };
      }, [controller]);
      return h(ArchiveVisibilitySwitch, {
        visible,
        classes,
        labelShow: controller.labelShow,
        labelHide: controller.labelHide,
        onToggle: () => controller.toggle(!visible),
      });
    }

    /**
     * Create the global "show archived sessions" switch and its visibility
     * controller.
     *
     * The switch is one plugin-owned row injected into the sidebar panel list
     * directly below 自动化任务, reusing the live panel-row classes so it matches
     * the surrounding rows (and their collapsed-rail layout). It replaces the
     * old per-workspace menu toggle: one click flips one global state, and the
     * controller drives the built-in archived filter to `show` (all archived
     * sessions of every workspace visible) or `default` (all hidden). A guard
     * attribute plus a CSS rule hide archived rows from the instant they render,
     * so a failed/racy filter drive can never flash stale archived rows.
     * @param ctx - client root context.
     * @returns disposer removing the injected row, observers and row markers.
     */
    function createArchivedVisibility(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      if (typeof createRoot !== 'function') return () => {};

      const label = viewOptionLabels(ctx);
      const viewOptionsLabel = label('viewOptions.label');
      const showArchivedLabel = label('viewOptions.showArchived');
      const onlyArchivedLabel = label('viewOptions.onlyArchived');
      const hideArchivedLabel = label('viewOptions.hideArchived');

      let pluginT;
      try {
        pluginT = ctx.locale.bind(NS);
      } catch {
        pluginT = (key) => key;
      }
      const tr = (key) => {
        try {
          const value = pluginT(key);
          return typeof value === 'string' && value !== '' ? value : key;
        } catch {
          return key;
        }
      };
      const labelShow = tr('archive.show');
      const labelHide = tr('archive.hide');

      const visibility = createStore(loadArchiveVisible());
      const layout = createStore({ rowClass: undefined, glyphClass: undefined, titleClass: undefined, compact: false });
      /** Face handed to the injected React root. `toggle` is a hoisted declaration below. */
      const controller = { visibility, layout, toggle, labelShow, labelHide };

      /** Injected container / React root; re-created if React removes the row. */
      let container = null;
      let root = null;
      let insertedAfter = null;
      let resizeObserver = null;
      let resizedNav = null;
      let disposed = false;
      let scheduled = false;
      let bootstrapped = false;
      let lastDriveAt = 0;
      let driveAttempts = 0;
      let lastTarget = null;

      /**
       * Set or clear the plugin-owned hidden marker on rendered archived rows.
       * @param visible - current global visibility.
       */
      function syncRowMarkers(visible) {
        for (const row of document.querySelectorAll('[data-row-key^="session:"]')) {
          const archived = row.hasAttribute('aria-description') || hasClassSuffix(row, '_archived');
          if (archived && !visible) {
            if (!row.hasAttribute(HIDDEN_ATTR)) row.setAttribute(HIDDEN_ATTR, '');
          } else if (row.hasAttribute(HIDDEN_ATTR)) {
            row.removeAttribute(HIDDEN_ATTR);
          }
        }
      }

      /**
       * Apply the visibility state to the DOM immediately: the guard attribute
       * hides every archived row synchronously while the built-in filter is
       * driven to the matching value.
       * @param visible - whether archived sessions must be visible.
       */
      function applyVisibility(visible) {
        const rootElement = document.documentElement;
        if (rootElement !== null) {
          if (visible) rootElement.removeAttribute(GUARD_ATTR);
          else rootElement.setAttribute(GUARD_ATTR, 'all');
        }
        syncRowMarkers(visible);
        driveFilter(visible ? 'show' : 'default');
      }

      /**
       * Drive the built-in archived filter through the WorkspaceBrowser store
       * actions; the localized view-options menu is the fallback.
       * @param filter - target filter value.
       * @returns true when the action was invoked synchronously.
       */
      function driveFilter(filter) {
        const now = Date.now();
        if (now - lastDriveAt < 120) return false;
        lastDriveAt = now;
        const actions = findWorkspaceViewActions();
        if (actions !== undefined) {
          try {
            actions.setArchivedFilter(filter);
            return true;
          } catch {
            /* fall through to the menu path */
          }
        }
        void applyFilterViaMenu(filter);
        return false;
      }

      /**
       * Fallback for builds where the fiber walk fails: open the sidebar view
       * options menu, activate the matching archived-filter row, close it.
       * @param filter - target filter value.
       * @returns promise resolving true when a menu row was activated.
       */
      async function applyFilterViaMenu(filter) {
        const trigger = Array.from(document.querySelectorAll('button[aria-label]')).find(
          (button) => button.getAttribute('aria-label') === viewOptionsLabel,
        );
        if (trigger === undefined) return false;
        trigger.click();
        const target = filter === 'show' ? showArchivedLabel : filter === 'only' ? onlyArchivedLabel : hideArchivedLabel;
        const deadline = Date.now() + 900;
        while (Date.now() < deadline && !disposed) {
          await new Promise((resolve) => window.setTimeout(resolve, 25));
          const cards = Array.from(document.querySelectorAll('[data-menu-material]'));
          for (const card of cards) {
            const item = Array.from(card.querySelectorAll('button[role="menuitem"]')).find(
              (button) => (button.textContent ?? '').trim() === target,
            );
            if (item !== undefined) {
              item.click();
              return true;
            }
          }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return false;
      }

      /** @returns whether the built-in filter currently matches `target`. */
      function filterSettled(target) {
        const persisted = readArchivedFilter();
        if (persisted === target) return true;
        if (persisted !== undefined) return false;
        const rendered = Array.from(document.querySelectorAll('[data-row-key^="session:"]')).filter(
          (row) => row.hasAttribute('aria-description') && row.getClientRects().length > 0,
        );
        return target === 'show' ? rendered.length > 0 : rendered.length === 0;
      }

      /**
       * Capture the live sidebar panel-row classes so the injected row matches
       * the surrounding rows without hard-coding hashed CSS-module names.
       * @param anchor - one rendered panel-row button.
       * @returns class strings for the row, glyph and title.
       */
      function captureClasses(anchor) {
        const spans = Array.from(anchor.querySelectorAll('span'));
        const glyph = spans.find((span) => hasClassSuffix(span, '_panelGlyph')) ?? spans[0];
        const title =
          spans.find((span) => hasClassSuffix(span, '_panelTitle')) ??
          spans.find((span) => span !== glyph && (span.textContent ?? '').trim().length > 0);
        return {
          rowClass: anchor.getAttribute('class') ?? undefined,
          glyphClass: glyph === undefined ? undefined : glyph.getAttribute('class') ?? undefined,
          titleClass: title === undefined ? undefined : title.getAttribute('class') ?? undefined,
        };
      }

      /** @returns the sidebar panel-list nav, when mounted. */
      function findPanelNav() {
        return document.querySelector('nav[class*="panelList"]');
      }

      /**
       * @param nav - sidebar panel-list nav.
       * @returns the normally rendered panel-row buttons, excluding the More launcher.
       */
      function panelRows(nav) {
        return Array.from(nav.querySelectorAll('button')).filter(
          (button) => button.getAttribute('aria-haspopup') !== 'menu' && button.getAttribute('aria-expanded') === null,
        );
      }

      /**
       * @param rows - panel-row buttons.
       * @returns the 自动化任务 row when present, else the second (then first) row.
       */
      function anchorRow(rows) {
        const automation = rows.find((row) => /自动化|Automation|Schedul/i.test(row.getAttribute('aria-label') ?? ''));
        return automation ?? rows[1] ?? rows[0];
      }

      /** Create/refresh the injected switch row; harmless when the nav is absent. */
      function ensureSwitchRow() {
        const nav = findPanelNav();
        if (nav === null) return;
        const rows = panelRows(nav);
        if (rows.length === 0) return;
        const anchor = anchorRow(rows);
        if (anchor === undefined) return;

        const classes = captureClasses(anchor);
        const compact = nav.getBoundingClientRect().width < 90;
        const nextLayout = { ...classes, compact };
        const currentLayout = layout.getSnapshot();
        if (
          currentLayout.rowClass !== nextLayout.rowClass ||
          currentLayout.glyphClass !== nextLayout.glyphClass ||
          currentLayout.titleClass !== nextLayout.titleClass ||
          currentLayout.compact !== nextLayout.compact
        ) {
          layout.set(nextLayout);
        }

        if (container === null || !container.isConnected) {
          container = document.createElement('div');
          container.setAttribute(TOGGLE_ATTR, '');
          if (compact) container.classList.add('spc-archive-compact');
          if (root === null) root = createRoot(container);
          anchor.parentNode.insertBefore(container, anchor.nextSibling);
          insertedAfter = anchor;
          root.render(h(ArchiveVisibilityHost, { controller }));
        } else if (insertedAfter !== anchor || container.previousSibling !== anchor) {
          anchor.parentNode.insertBefore(container, anchor.nextSibling);
          insertedAfter = anchor;
        }
        if (currentLayout.compact !== compact) {
          container.classList.toggle('spc-archive-compact', compact);
        }

        if (resizedNav !== nav) {
          if (resizeObserver !== null) resizeObserver.disconnect();
          if (typeof ResizeObserver === 'function') {
            resizeObserver = new ResizeObserver(() => schedule());
            resizeObserver.observe(nav);
          }
          resizedNav = nav;
        }
      }

      /** Toggle the single global visibility state. */
      function toggle(next) {
        const value = next === true;
        visibility.set(value);
        persistArchiveVisible(value);
        driveAttempts = 0;
        lastTarget = value ? 'show' : 'default';
        applyVisibility(value);
        schedule();
      }

      /** Reconcile the guard, row markers, injected row and built-in filter. */
      function reconcile() {
        if (disposed) return;
        ensureSwitchRow();
        const visible = visibility.getSnapshot() === true;
        const target = visible ? 'show' : 'default';
        if (lastTarget !== target) {
          lastTarget = target;
          driveAttempts = 0;
        }
        if (target === 'default') {
          const rootElement = document.documentElement;
          if (rootElement !== null && rootElement.getAttribute(GUARD_ATTR) !== 'all') rootElement.setAttribute(GUARD_ATTR, 'all');
        } else {
          const rootElement = document.documentElement;
          if (rootElement !== null && rootElement.hasAttribute(GUARD_ATTR)) rootElement.removeAttribute(GUARD_ATTR);
        }
        syncRowMarkers(visible);
        if (!bootstrapped) {
          bootstrapped = true;
          applyVisibility(visible);
          return;
        }
        if (!filterSettled(target)) {
          if (driveAttempts < 12) {
            driveAttempts += 1;
            driveFilter(target);
          }
        } else {
          driveAttempts = 0;
        }
      }

      /** Schedule one reconcile on the next animation frame. */
      function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        window.requestAnimationFrame(() => {
          scheduled = false;
          reconcile();
        });
      }

      /**
       * Whether one DOM mutation can affect the sidebar rows, the panel list or
       * a portaled menu. Filters out chat streaming churn so the controller
       * stays idle while a conversation renders.
       * @param node - added/removed node.
       * @returns true when the node may matter.
       */
      function isRelevantNode(node) {
        if (!(node instanceof Element)) return false;
        if (node.matches('[data-row-key], [data-menu-material], nav, button')) return true;
        return node.querySelector('[data-row-key], [data-menu-material], nav') !== null;
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes') {
            const target = record.target;
            if (!(target instanceof Element)) continue;
            if (target.matches('[data-row-key], nav') || target.closest('[data-row-key]') !== null) {
              schedule();
              return;
            }
            continue;
          }
          for (const node of record.addedNodes) {
            if (isRelevantNode(node)) {
              schedule();
              return;
            }
          }
          for (const node of record.removedNodes) {
            if (isRelevantNode(node)) {
              schedule();
              return;
            }
          }
        }
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'aria-description', 'data-row-key'],
      });
      schedule();

      return () => {
        disposed = true;
        observer.disconnect();
        if (resizeObserver !== null) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
        if (root !== null) {
          try {
            root.unmount();
          } catch {
            /* the container may already be detached */
          }
          root = null;
        }
        if (container !== null && container.isConnected) container.remove();
        container = null;
        insertedAfter = null;
        const rootElement = document.documentElement;
        if (rootElement !== null) rootElement.removeAttribute(GUARD_ATTR);
        for (const row of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) row.removeAttribute(HIDDEN_ATTR);
      };
    }

    // ─────────────────────────────── plugin wiring ──────────────────────────

    /**
     * Services the browser half consumes. `slots` and `locale` are the
     * contribution surface; `sessions`/`workspaces` are read for navigation
     * after a deletion. Optional lookups (`uiWorkspace`) go through `ctx.get`.
     */
    const inject = ['slots', 'locale', 'sessions', 'workspaces'];

    /**
     * Client plugin body.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-cleaner: dictionaries');

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {};
        const styleId = 'dsh-plugin-session-cleaner/styles';
        if (document.querySelector(`style[data-plugin-css="${styleId}"]`) !== null) return () => {};
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-plugin-session-cleaner';
        tag.dataset.pluginCss = styleId;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => {
          tag.remove();
        };
      }, 'session-cleaner: styles');

      const requestStore = createStore(null);
      const toastStore = createStore(null);
      let requestSeq = 0;
      let toastSeq = 0;

      let t;
      try {
        t = ctx.locale.bind(NS);
      } catch {
        t = (key) => key;
      }

      const requestDelete = (sessionId, displayTitle) => {
        requestStore.set({ sessionId, displayTitle, seq: ++requestSeq });
      };

      const cancelDelete = () => requestStore.set(null);
      const dismissToast = () => toastStore.set(null);
      const showToast = (text, tone) => toastStore.set({ text, tone, seq: ++toastSeq });

      /**
       * Capture the workspace and main-view status before the row disappears,
       * then ask the host to purge the Session. On success, a deleted main view
       * is replaced with a fresh session in the same workspace.
       * @param request - pending confirmation request.
       * @returns `{ ok:false, code, message }` on failure.
       */
      const confirmDelete = async (request) => {
        const sessionId = request.sessionId;
        let workspaceId;
        let wasCurrent = false;
        try {
          const workspaces = ctx.get('workspaces');
          const workspaceSnapshot = workspaces === undefined ? undefined : workspaces.list.getSnapshot();
          const owner = workspaceSnapshot === undefined ? undefined : workspaceSnapshot.items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId));
          workspaceId = owner === undefined ? undefined : owner.workspaceId;
          const sessions = ctx.get('sessions');
          const summary = sessions === undefined ? undefined : sessions.list.getSnapshot().byId[sessionId];
          wasCurrent = summary !== undefined && (summary.retainedBy?.mainView ?? 0) > 0;
        } catch {
          workspaceId = undefined;
          wasCurrent = false;
        }

        const result = await callDeleteSession(sessionId);
        if (result.ok !== true) return result;

        showToast(t('delete.done'), 'success');
        if (wasCurrent) {
          try {
            const uiWorkspace = ctx.get('uiWorkspace');
            if (uiWorkspace !== undefined && typeof uiWorkspace.startSession === 'function') uiWorkspace.startSession(workspaceId);
          } catch (error) {
            console.warn('[session-cleaner] reopening a fresh session after deletion failed:', error);
          }
        }
        return { ok: true };
      };

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-cleaner.delete',
            order: 500,
            locale: NS,
            inject: () => ({ requestDelete }),
          },
          DeleteSessionMenuItem,
        ),
      );

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'session-cleaner.delete',
            locale: NS,
            inject: () => ({
              hooks: { request: requestStore, toast: toastStore },
              dismissToast,
              cancelDelete,
              confirmDelete,
            }),
          },
          DeleteSessionOverlay,
        ),
      );

      ctx.effect(() => createArchivedVisibility(ctx), 'session-cleaner: workspace archived visibility');
    }

    return { inject, apply };
  },
});
