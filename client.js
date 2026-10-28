window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-cleaner',
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
      'menu.showArchived': '显示归档会话',
      'menu.hideArchived': '隐藏归档会话',
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
      'error.live': '该会话已被 DSH 打开并在内存中保留，需要重启 DSH 后才能永久删除。请重启 DSH，再从侧栏删除。',
      'error.active': '会话仍有进行中的工作。请先停止这些工作后重试。',
      'error.workspace': '无法从工作区移除该会话，删除已中止。',
      'error.failed': '删除会话失败：{message}',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'menu.delete': 'Delete session',
      'menu.showArchived': 'Show archived sessions',
      'menu.hideArchived': 'Hide archived sessions',
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
      'error.live': 'This session is still held in memory because DSH has opened it. Restart DSH, then delete it from the sidebar.',
      'error.active': 'This session still has running work. Stop that work and retry.',
      'error.workspace': 'The session could not be detached from its workspace; deletion was aborted.',
      'error.failed': 'Deleting the session failed: {message}',
    };

    /** Plugin-local stylesheet; only the surfaces the primitives do not style. */
    const CSS = [
      '.spc-dialog-note{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;margin:0 0 8px}',
      '.spc-dialog-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin-top:8px;white-space:pre-wrap}',
      '.spc-dialog-warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary));font-size:12px;line-height:18px;margin-top:8px}',
      '.spc-dialog-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
    ].join('');

    const STORAGE_KEY = 'dsh.session-cleaner.workspace-archived';
    const LOCAL_STORAGE_ATTR = 'data-session-cleaner-hidden';

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

    // ───────────────── feature 2 · workspace archived visibility ────────────

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
     * Workspace-domain labels resolved from the `workspace` dictionary so the
     * DOM augmentation follows the active locale instead of hard-coded copy.
     * @param ctx - client root context.
     * @returns resolvers for the strings the controller needs.
     */
    function workspaceLabels(ctx) {
      const fallback = (key) => {
        switch (key) {
          case 'rename':
            return '重命名';
          case 'delete.workspace':
            return '删除工作区';
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
      return (key, params) => {
        try {
          const value = translate === undefined ? key : translate(key, params);
          if (typeof value !== 'string' || value === key) return fallback(key);
          return value;
        } catch {
          return fallback(key);
        }
      };
    }

    /**
     * Create the DOM augmentation that adds a per-workspace "show archived
     * sessions" toggle to the built-in workspace folder menu and applies the
     * chosen visibility to the sidebar rows.
     *
     * The owning package hard-codes that menu and declares no slot for it, so
     * this controller decorates the portaled menu card when it opens. The
     * archived filter itself is driven through the live WorkspaceBrowser store
     * actions found on the React fiber; a menu-click fallback covers builds
     * where the fiber walk fails.
     * @param ctx - client root context.
     * @returns disposer removing every listener/observer it installed.
     */
    function createArchivedVisibility(ctx) {
      if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
      if (typeof createRoot !== 'function') return () => {};

      const label = workspaceLabels(ctx);
      let pluginT;
      try {
        pluginT = ctx.locale.bind(NS);
      } catch {
        pluginT = (key) => key;
      }
      const pluginLabel = (key) => {
        try {
          const value = pluginT(key);
          return typeof value === 'string' && value !== '' ? value : key;
        } catch {
          return key;
        }
      };
      const renameLabel = label('rename');
      const deleteLabel = label('delete.workspace');
      const viewOptionsLabel = label('viewOptions.label');
      const showArchivedLabel = label('viewOptions.showArchived');
      const hideArchivedLabel = label('viewOptions.hideArchived');
      const onlyArchivedLabel = label('viewOptions.onlyArchived');
      const workspaceActionTemplate = label('actions.workspace.aria');
      const workspaceActionPrefix = workspaceActionTemplate.includes('{name}') ? workspaceActionTemplate.slice(0, workspaceActionTemplate.indexOf('{name}')) : undefined;
      const workspaceActionSuffix =
        workspaceActionPrefix === undefined ? undefined : workspaceActionTemplate.slice(workspaceActionTemplate.indexOf('{name}') + '{name}'.length);

      /** Persisted toggles plus the filter to restore once the last toggle turns off. */
      let state = loadState();
      /** Menu trigger click observed just before the owned menu opens. */
      let pendingMenu = null;
      /** One decoration per open menu card. */
      const decorations = new Map();
      let scheduled = false;
      let disposed = false;
      let bootstrapped = false;

      function loadState() {
        try {
          const raw = window.localStorage.getItem(STORAGE_KEY);
          if (raw === null || raw === '') return { enabled: {}, restoreFilter: null };
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object') return { enabled: {}, restoreFilter: null };
          const enabled = {};
          if (parsed.enabled !== null && typeof parsed.enabled === 'object') {
            for (const [key, value] of Object.entries(parsed.enabled)) if (value === true) enabled[key] = true;
          }
          const restoreFilter = parsed.restoreFilter === 'show' || parsed.restoreFilter === 'only' || parsed.restoreFilter === 'default' ? parsed.restoreFilter : null;
          return { enabled, restoreFilter };
        } catch {
          return { enabled: {}, restoreFilter: null };
        }
      }

      function saveState() {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch {
          /* storage may be unavailable in hardened contexts; state stays in memory */
        }
      }

      function enabledIds() {
        return Object.keys(state.enabled).filter((id) => state.enabled[id] === true);
      }

      function isEnabled(workspaceId) {
        return state.enabled[workspaceId] === true;
      }

      /**
       * Best-effort current filter read from what is on screen. Archived rows
       * are the only session rows carrying `aria-description`.
       * @returns `default`, `show`, or `only`.
       */
      function detectFilter() {
        const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'));
        if (rows.length === 0) return 'default';
        const archived = rows.filter((row) => row.hasAttribute('aria-description')).length;
        if (archived === 0) return 'default';
        if (archived === rows.length) return 'only';
        return 'show';
      }

      /**
       * Apply the archived filter through the WorkspaceBrowser actions.
       * @param filter - target filter value.
       * @returns true when the action was invoked.
       */
      function applyFilter(filter) {
        const actions = findWorkspaceViewActions();
        if (actions === undefined) return false;
        try {
          actions.setArchivedFilter(filter);
          return true;
        } catch {
          return false;
        }
      }

      /**
       * Fallback for builds where the fiber walk fails: open the sidebar view
       * options menu, activate the matching archived-filter row, and close it.
       * @param filter - target filter value.
       * @returns promise resolving after the click attempt.
       */
      async function applyFilterViaMenu(filter) {
        const trigger = Array.from(document.querySelectorAll('button[aria-label]')).find(
          (button) => button.getAttribute('aria-label') === viewOptionsLabel,
        );
        if (trigger === undefined) return;
        trigger.click();
        const target =
          filter === 'show' ? showArchivedLabel : filter === 'only' ? onlyArchivedLabel : hideArchivedLabel;
        const deadline = Date.now() + 800;
        while (Date.now() < deadline && !disposed) {
          await new Promise((resolve) => window.setTimeout(resolve, 25));
          const cards = Array.from(document.querySelectorAll('[data-menu-material]'));
          for (const card of cards) {
            const item = Array.from(card.querySelectorAll('button[role="menuitem"]')).find(
              (button) => (button.textContent ?? '').trim() === target,
            );
            if (item !== undefined) {
              item.click();
              return;
            }
          }
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }

      /**
       * Drive the built-in filter to `show`, remembering the previous value so
       * the last toggle can restore it.
       * @param next - filter the caller wants.
       */
      function setFilter(next) {
        if (applyFilter(next)) return;
        void applyFilterViaMenu(next);
      }

      /**
       * Map one session row to the workspace key of the group section that owns
       * it. Rows in the flat list (no section) map to the empty key.
       * @param row - session row element.
       * @returns workspace id or `''`.
       */
      function workspaceIdOf(row) {
        const section = row.closest('[style*="--dsh-workspace-indent"]');
        if (section === null) return '';
        const workspaceRow = section.querySelector('[data-row-key^="workspace:"]');
        if (workspaceRow === null) return '';
        const key = workspaceRow.getAttribute('data-row-key');
        return key === null ? '' : key.slice('workspace:'.length);
      }

      /** Hide archived rows of workspaces whose toggle is off, restore the rest. */
      function applyHiding() {
        const enabled = enabledIds();
        const rows = Array.from(document.querySelectorAll('[data-row-key^="session:"]'));
        if (enabled.length === 0) {
          // The plugin owns no archived visibility while every toggle is off;
          // a manual "show archived" choice in the built-in view options must
          // stay untouched.
          for (const row of rows) {
            if (!row.hasAttribute(LOCAL_STORAGE_ATTR)) continue;
            row.removeAttribute(LOCAL_STORAGE_ATTR);
            if (row.style.display === 'none') row.style.display = '';
          }
          return;
        }
        const grouped = document.querySelector('[data-row-key^="workspace:"]') !== null;
        for (const row of rows) {
          if (!row.hasAttribute('aria-description') || !grouped) {
            if (row.hasAttribute(LOCAL_STORAGE_ATTR)) {
              row.removeAttribute(LOCAL_STORAGE_ATTR);
              if (row.style.display === 'none') row.style.display = '';
            }
            continue;
          }
          const show = enabled.length > 0 && isEnabled(workspaceIdOf(row));
          if (show) {
            if (row.hasAttribute(LOCAL_STORAGE_ATTR)) {
              row.removeAttribute(LOCAL_STORAGE_ATTR);
              if (row.style.display === 'none') row.style.display = '';
            }
          } else if (row.style.display !== 'none') {
            row.setAttribute(LOCAL_STORAGE_ATTR, '');
            row.style.display = 'none';
          }
        }
      }

      /** Restore every row this controller hid (plugin unload). */
      function clearHiding() {
        for (const row of document.querySelectorAll(`[${LOCAL_STORAGE_ATTR}]`)) {
          row.removeAttribute(LOCAL_STORAGE_ATTR);
          row.style.display = '';
        }
      }

      /** @returns whether the sidebar has rendered any session rows yet. */
      function sidebarReady() {
        return document.querySelector('[data-row-key^="session:"]') !== null || document.querySelector('[data-row-key^="workspace:"]') !== null;
      }

      /**
       * Reconcile the rendered archived rows after any relevant DOM change.
       */
      function tick() {
        if (disposed) return;
        cleanupDecorations();
        decoratePendingMenu();
        if (!bootstrapped && sidebarReady()) {
          bootstrapped = true;
          if (enabledIds().length > 0) setFilter('show');
        }
        applyHiding();
      }

      function schedule() {
        if (scheduled || disposed) return;
        scheduled = true;
        window.requestAnimationFrame(() => {
          scheduled = false;
          tick();
        });
      }

      /** Unmount decorations whose menu card left the document. */
      function cleanupDecorations() {
        for (const [card, decoration] of decorations) {
          if (document.contains(card)) continue;
          decorations.delete(card);
          try {
            decoration.root.unmount();
          } catch {
            /* the card may be removed while React is already unmounting */
          }
        }
      }

      /**
       * Remember a workspace menu trigger press. The owned menu opens on click,
       * one frame after the pointerdown this listener observes.
       * @param event - document pointerdown.
       */
      function onPointerDown(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const row = target.closest('[data-row-key^="workspace:"]');
        if (row === null) return;
        const actions = row.lastElementChild;
        if (actions === null) return;
        const buttons = actions.querySelectorAll('button');
        if (buttons.length < 2) return;
        const trigger = buttons[0];
        if (!(trigger === target || trigger.contains(target))) return;
        const aria = trigger.getAttribute('aria-label');
        if (workspaceActionPrefix !== undefined && (aria === null || !aria.startsWith(workspaceActionPrefix) || !aria.endsWith(workspaceActionSuffix))) return;
        const key = row.getAttribute('data-row-key');
        if (key === null) return;
        pendingMenu = { workspaceId: key.slice('workspace:'.length), at: Date.now() };
        schedule();
      }

      /** Append the toggle to the workspace menu card that just opened. */
      function decoratePendingMenu() {
        if (pendingMenu === null) return;
        if (Date.now() - pendingMenu.at > 3000) {
          pendingMenu = null;
          return;
        }
        const cards = Array.from(document.querySelectorAll('[data-menu-material]'));
        for (const card of cards) {
          if (decorations.has(card)) continue;
          if (!isWorkspaceMenu(card)) continue;
          decorateMenu(card, pendingMenu.workspaceId);
          pendingMenu = null;
          return;
        }
      }

      /**
       * @param card - portaled menu card.
       * @returns true when the card holds both built-in workspace rows.
       */
      function isWorkspaceMenu(card) {
        const labels = Array.from(card.querySelectorAll('button[role="menuitem"]'), (button) => (button.textContent ?? '').trim());
        return labels.includes(renameLabel) && labels.includes(deleteLabel);
      }

      /**
       * Render the toggle row between rename and delete.
       * @param card - portaled menu card.
       * @param workspaceId - workspace the menu belongs to.
       */
      function decorateMenu(card, workspaceId) {
        const viewport = Array.from(card.children).find((child) => child.getAttribute('role') === 'presentation');
        if (viewport === undefined) return;
        const container = document.createElement('div');
        container.setAttribute('data-session-cleaner-menu', '');
        const root = createRoot(container);
        const closeMenu = () => {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        };
        const render = () => {
          const on = isEnabled(workspaceId);
          root.render(
            h(
              primitives.MenuItemButton,
              {
                icon: h(on ? primitives.IconArchiveCheckOutlineRegular : primitives.IconArchiveOutlineRegular, { size: 16 }),
                current: on,
                onSelect: () => {
                  setWorkspaceEnabled(workspaceId, !on);
                  closeMenu();
                },
              },
              on ? pluginLabel('menu.hideArchived') : pluginLabel('menu.showArchived'),
            ),
          );
        };
        decorations.set(card, { root, container });
        const children = Array.from(viewport.children);
        let lastItem;
        for (let index = children.length - 1; index >= 0; index -= 1) {
          const child = children[index];
          const button = child.querySelector === undefined ? null : child.querySelector('button[role="menuitem"]');
          if (button !== null && button !== undefined && (button.textContent ?? '').trim() === deleteLabel) {
            lastItem = child;
            break;
          }
        }
        if (lastItem !== undefined) viewport.insertBefore(container, lastItem);
        else viewport.appendChild(container);
        render();
      }

      /**
       * Toggle one workspace and reconcile the built-in archived filter.
       * @param workspaceId - toggled workspace.
       * @param next - whether archived sessions should show there.
       */
      function setWorkspaceEnabled(workspaceId, next) {
        if (next) state.enabled[workspaceId] = true;
        else delete state.enabled[workspaceId];
        if (enabledIds().length > 0) {
          if (state.restoreFilter === null) state.restoreFilter = detectFilter();
          saveState();
          setFilter('show');
        } else {
          const restore = state.restoreFilter === null ? 'default' : state.restoreFilter;
          state.restoreFilter = null;
          saveState();
          setFilter(restore);
        }
        schedule();
      }

      document.addEventListener('pointerdown', onPointerDown, true);
      /**
       * Whether one DOM mutation can affect the sidebar rows, workspace groups
       * or a portaled menu. Filters out chat streaming churn so the controller
       * stays idle while a conversation renders.
       * @param node - added/removed node.
       * @returns true when the node may matter.
       */
      function isRelevantNode(node) {
        if (!(node instanceof Element)) return false;
        if (node.matches('[data-row-key], [data-menu-material]')) return true;
        return node.querySelector('[data-row-key], [data-menu-material]') !== null;
      }

      const observer = new MutationObserver((records) => {
        for (const record of records) {
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
      observer.observe(document.body, { childList: true, subtree: true });
      schedule();

      return () => {
        disposed = true;
        document.removeEventListener('pointerdown', onPointerDown, true);
        observer.disconnect();
        cleanupDecorations();
        clearHiding();
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
