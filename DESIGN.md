# dsh-plugin-session-cleaner — internal design / team contract

Status: working notes for the build. Not shipped in the npm package. Keep this file
updated when a contract changes.

## Package identity (contract)

The published package is `@estelle-ge/dsh-plugin-session-cleaner` (GitHub repo:
`gcggcg/dsh-plugin-session-cleaner`). Three places MUST carry the same string or the
plugin silently fails to load:

1. `package.json` → `name`;
2. `cordis.patch.yml` → the `insert[].name` **quoted** (a bare `@` starts a YAML
   indicator and makes the overlay unparsable);
3. `client.js` → `window.__ModuleLoader__.load({ id: ... })` (the client module
   registry is keyed by package name).

Internal DOM markers (`data-plugin="dsh-plugin-session-cleaner"`, the CSS style key and
the `localStorage` key) intentionally keep the short historical name; they are not
package identity. The local desktop profiles link the checkout under the scoped name.

## Goal

One DSH bundle plugin that adds two sidebar features to the DeepSeek Harness Web GUI:

1. **Delete session** — the session row `...` menu (`sidebar.workspaces.session.menu.item`)
   gets a destructive **删除会话** item. Confirming permanently removes the session
   log from disk and all workspace/global bookkeeping, so the row disappears for good.
2. **Global archived-session visibility** — one switch row in the sidebar panel list,
   directly below 自动化任务: OFF (default) hides every archived session, ON shows every
   archived session of every workspace (and the ungrouped bucket). This replaced the
   original per-workspace toggle in the workspace folder row `...` menu, which the user
   rejected because it needed repeat clicks and per-workspace visits.

DSH target: `>=0.2.1-rc.3 <0.3.0-0` (installed build 0.2.1-rc.3). Node/Electron
`D:\...\app.asar` internals were researched from the packaged bundles; the summary lives
in this file.

## Repo layout and ownership

```
package.json            Lead
cordis.patch.yml        Lead
index.js                host-engineer (thin re-export of src/host/plugin.js)
src/host/*.js           host-engineer
client.js               Lead (single browser bundle; no build step)
locale/zh.json,en.json  Lead (market metadata only)
icon.svg                Lead
smoke.mjs               Lead
README.md               Lead
test/host/*.test.mjs    host-engineer
test/e2e/*.mjs          test-infra
scripts/*.mjs           test-infra
docs/dom-recon.md       test-infra
DESIGN.md               Lead
.tmp-test/              test-infra scratch (gitignored)
```

Do not edit files outside your scope without messaging the Lead first.

## Feature 1 — host side (host-engineer)

### Transport

The client cannot use a generated Typert Remote (that needs codegen), so the host half
registers one HTTP route on `ctx.webServer` (service available because the profile loads
`@deepseek-ai/dsh-web-app`):

```js
{ kind: 'prefix', path: '/api/session-cleaner', handler }
```

Handlers MUST call `ctx.get('connection').requestRejection(req)` first and answer
`401`/`403` when it returns a status; this reuses the exact browser-cookie / Host /
Origin fence of the built-in `/api` bridge. Accept only `POST` + `application/json`,
read at most 64 KiB, and answer JSON.

`POST /api/session-cleaner/delete` body `{ "sessionId": string }`

Success: `200 {"ok":true,"sessionId":"..."}`

Failure: `4xx/5xx {"ok":false,"error":{"code":"<stable-code>","message":"...","details":{}}}`
Stable codes (client displays localized text, never the raw message):
- `session/invalid` — malformed/unsafe id (accepted grammar: `session-<uuid>`, legacy
  `sess_<uuid>`, bare `<uuid>` subagent ids)
- `session/not-found` — no stored session with that id
- `session/live` — **deprecated, no longer emitted**: a session that DSH has merely
  opened/attached is deletable without a restart. Older clients may still translate it.
- `session/active` — nothing was deleted because work still owns the session:
  - `workspace/session-activity` reported running work (`details.activity` is the same
    array shape the workspace archive confirmation uses), or
  - the session's Agent was `running`, the host cancelled it, and it did not leave
    `running` within the stop budget (`details.activity=[{"kind":"agent"}]` plus
    `details.reason`).
- `workspace/refused` — workspace bookkeeping detach failed
- `delete/failed` — filesystem removal failed (message has the OS error)
`GET /api/session-cleaner/health` → `200 {"ok":true,"plugin":"session-cleaner"}` for tests.

### Deletion algorithm (must be safe and idempotent)

Resolve services lazily with `ctx.get(name)` at request time (host plugin must load even
when an optional service is absent):
- `sessionPersistence` (required; JSONL backend) — `stat(id)` gives `{header}` with
  `header.cwd`. If `undefined` → `session/not-found`.
- `root` property of the JSONL backend instance is the sessions root (default
  `<dsh home>/sessions`). If absent, fail `delete/failed`.
- session directory: scan `<root>/<projectDir>/<id>` one workspace level deep and use the
  directory literally named after the id (the backend's own `findLog` behaves the same way,
  so a stale/mismatched header `cwd` cannot misdirect the delete). If no directory is
  found, fall back to the deterministic `<root>/<projectKey(cwd)>/<encodeSegment(id)>`
  (unmaterialized session: force-rm is then a legitimate no-op). The encoder helpers are
  copied from `dsh-session-persistence-jsonl` in `src/host/encoding.js`.
- `sessions` / `agents` services: read `ctx.get('sessions')?.get(id)` and
  `ctx.get('agents')?.get(id)` **before** mutating anything, but do NOT refuse merely
  because the session is attached:
  - attached + idle (no Agent, or Agent not `running`): delete the artifact anyway. The
    JSONL backend's Windows write lock is a named kernel semaphore (no lock file) and
    libuv opens logs with `FILE_SHARE_DELETE`, so `fs.rm` succeeds on the open artifact;
    the `api-session/removed` broadcast drops the stale browser row.
  - Agent `running`: cancel it (`agent.cancel({kind:'user'},{keepInbox:false})`, falling
    back to `abort()`/`interrupt()`), poll `agent.status !== 'running'` for the stop budget
    (default 8000 ms; `DSH_SESSION_CLEANER_STOP_MS` 500–60000 overrides). Still running →
    `session/active`, **nothing deleted, bookkeeping untouched**.
- activity: `await ctx.waterfall('workspace/session-activity', { sessionId })`; non-empty
  → `session/active` with `details.activity` (checked after the Agent has stopped).
- remove references before files:
  - `registry = ctx.get('workspaceRegistry')`; for every `registry.list()` entity whose
    `sessionIds.includes(id)` call `entity.detachSession(id)` (method exists at runtime
    even though the public TS interface hides it).
  - `await registry.unarchiveSession(id)` and `await registry.unpinSession(id)`
    (both are idempotent / no existence check).
- `fs.rm(sessionDir, { recursive: true, force: true })`
- remove derived data (warnings only; the log is already gone): the projection cache
  `<dsh home>/storages/session_projcache/sessions/<id>.json` and the derived SQLite search
  indexes `<dsh home>/storages/*.{db,sqlite,sqlite3}` (plus `-wal`/`-shm` after a db was
  removed) — a stale projection-cache record can revive the deleted session's title after a
  restart. The storages sibling is only treated as DSH's tree when it carries one of
  `session_projcache` / `workspace.json` / `schedule.json`, and every target is contained
  to it, so a custom sessions root cannot make the plugin delete unrelated files.
- `ctx.emit('api-session/removed', id)` so every connected browser drops the summary row.
- response `{ok:true}`.

The host no longer refuses a session because DSH has it attached; it only refuses while the
session's Agent cannot be stopped. The plugin must not crash the host: wrap the whole
handler; log with `ctx.logger`.

## Feature 2 — global archived visibility switch (Lead)

The user rejected the first design (a per-workspace toggle injected into the workspace
folder menu): it required one visit per workspace and clicking it often took several
attempts. The workspace-menu toggle is **removed**; one global switch in the sidebar panel
list replaces it.

- The switch row is injected into the official `sidebar.panellist` nav
  (`nav[class*="panelList"]`, a list slot) directly after the 自动化任务 panel row:
  - capture the live panel-row CSS-module class names (row / glyph / title) from an
    existing row so the injected row matches the surrounding rows in wide and collapsed
    rails without hard-coding hashed names;
  - render a `button[role="switch"]` with `aria-checked`, localized aria-label
    (`archive.show` / `archive.hide`) and a pill switch; marker container
    `[data-session-cleaner-archive-toggle]`, kept in place by the observer if React
    re-renders the nav.
- One global state in `localStorage` under `dsh.session-cleaner.archived-visible`
  (`'1'` shown, `'0'`/absent hidden, default hidden); the legacy
  `dsh.session-cleaner.workspace-archived` record is removed on load.
- Visibility is plugin-owned and deterministic: shown → built-in archived filter driven to
  `show` (archived sessions of every workspace and the ungrouped bucket render); hidden →
  driven to `default` **and** every rendered archived row carries
  `data-session-cleaner-archived-hidden` with
  `[data-session-cleaner-archived-hidden]{display:none !important}`. A root guard
  (`html[data-session-cleaner-archived-guard="all"]`) hides archived rows from their first
  render while the switch is off, so a failed/racy filter drive cannot flash them.
- The filter is driven through the WorkspaceBrowser fiber actions
  (`actions.setArchivedFilter`) with the localized view-options menu-click fallback; the
  persisted `dsh.workspace.view.v5`.archivedFilter is the settle signal, and a bounded
  re-assert cancels manual view-option picks while the switch is off.
- One click flips the state and applies it synchronously (guard immediate, filter retried);
  the switch is the single source of truth, so it cannot inherit a stale detected filter
  and needs no repeat clicks.
- A `MutationObserver` watches the sidebar DOM (childList plus `class` / `style` /
  `aria-description` / `data-row-key` attributes) to re-inject the row, re-apply markers
  and re-assert the filter; a `ResizeObserver` on the nav toggles the compact (rail) layout.
- Consequence (documented in README): while the switch is off, the built-in
  "全部对话（显示已归档）" view option is neutralized (archived rows stay hidden). To
  unarchive an archived session, turn the sidebar switch on first.

## Feature 1 — client side (Lead)

- Locale namespace `sessionCleaner`.
- Menu item: `ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)` with
  `id: 'session-cleaner.delete'`, `order: 500`, `danger`, `separatorBefore`; gets
  `sessionId`/`displayTitle` and the slot-level `useMenuOpenState` hook.
- Confirmation: one `shell.overlay` registration rendering a body-portaled `Modal`
  (primitives) with the target title; confirm calls the host route with
  `fetch('/api/session-cleaner/delete', ...)`; success shows a `Toast`; failure shows
  localized messages by error code (`session/active`, `workspace/refused`, …); a session
  that DSH has opened is deletable now (the host stops a running Agent and removes the
  artifact even while the session handle is open).
- Before calling the host, capture the workspace id from the client `workspaces` service;
  after success, if the deleted session was the main-view session, open a fresh session
  in that workspace via `ctx.get('uiWorkspace').startSession(workspaceId)`.
- Keep the plugin bundle self-contained: no new runtime npm dependencies in `client.js`.

## Test plan

- `node smoke.mjs` — static/module smoke: package manifest, locale key parity, host
  entry exports, client bundle loads with a fake `window.__ModuleLoader__` + require map,
  inject list sanity.
- `node --test test/host` — host unit tests with a fake ctx (temp sessions root):
  44 tests covering cold/attached/running-Agent deletion, projection-cache + search-index
  cleanup, id grammar, directory scan/containment, and the HTTP route.
- `node test/e2e/run.mjs` — isolated second DSH Web instance under `.tmp-test/` (separate
  `DSH_HOME`, seed `sessions/` + `storages/workspace.json`, deterministic log-backed
  archived fixtures), Playwright against the printed authenticated URL: 11 checks
  (one global switch injected below 自动化任务, default OFF hides every archived session,
  ONE click shows every archived session of every workspace + the ungrouped bucket, ONE
  click hides them again, manual "show archived" cannot resurrect them while OFF, reload
  persistence, attached-session delete incl. projcache removal, host route auth/errors,
  no page errors).
- `node test/e2e/desktop-check.mjs` (optional, skippable) — boots a SECOND packaged
  Desktop instance with its own `--user-data-dir`/`DSH_HOME` and drives the real
  `dsh-app://app` shell: 9 checks (switch loads below 自动化任务, default OFF, one-click
  ON/OFF across workspaces + ungrouped, manual view-option override, reload persistence,
  opened-session delete, cold delete + projcache, no page errors). Exits 0 with a SKIP
  when the packaged app / user's real Desktop profile / seed is unavailable.

## Implementation status (final, this build)

- Feature 1 (delete session) is implemented and verified end-to-end:
  slot row -> confirmation Modal -> authenticated host route -> running-Agent stop ->
  bookkeeping detach + log-directory/projection-cache removal + `api-session/removed`
  broadcast. The row disappears without a page reload, the toast shows,
  workspace/archive/pin bookkeeping, the log directory and the projection-cache record
  are gone (asserted in `test/e2e/run.mjs`). A session DSH has already opened is
  deletable without restarting; attached-but-idle sessions are removed while open on
  Windows (verified: named kernel-semaphore write lock + `FILE_SHARE_DELETE`), and a
  running Agent is cancelled and awaited first (`session/active` if it will not stop,
  with nothing mutated).
- Feature 2 (global archived visibility switch) is implemented and verified: one switch
  row injected into the official `sidebar.panellist` nav directly below 自动化任务, reusing
  the live panel-row CSS-module classes; default OFF; ONE click shows every archived
  session of every workspace (including the ungrouped bucket) and ONE click hides them
  again; the built-in archived filter is plugin-owned and re-asserted, archived rows are
  hidden by a CSS + guard mechanism that re-renders cannot wipe; state persists in
  `localStorage` and survives reload. The old per-workspace menu toggle (which often needed
  several clicks) is removed.
- Root causes fixed in this build (reported post-install failures, reproduced in the real
  Desktop shell): (1) the host refused every session DSH had merely opened with
  `session/live` and told the user to restart DSH — now attached-idle sessions are
  deletable and only an unstoppable running Agent refuses; (2) the plugin restored the
  *detected* built-in filter on toggle-off (the reporter's was `show`), so archived
  sessions could never be hidden again, and hiding used inline `style.display` that
  React re-renders wiped — now the filter is plugin-owned (`show` iff the switch is on) and
  hiding is an injected CSS rule + row attributes. Cold deletes also left the projection
  cache behind, and the id grammar rejected valid bare-uuid session ids; both fixed.
  (3) The per-workspace menu toggle was replaced by the single global sidebar switch
  (0.2.0) after the user reported it needed repeat clicks.
- Tests (post-fix, all green): `node smoke.mjs` 8/8, `npm test` 44/44,
  `npm run test:e2e` 11/11, optional `npm run test:desktop` 9/9.
- Recon facts the implementation depends on are recorded in
  `docs/dom-recon.md`; if a future DSH build changes the workspace menu DOM or
  the WorkspaceBrowser props, that file is the first place to update.

### Deferred (not in this build)

- Disposing an attached-but-idle Session from the host's in-memory store: DSH ships no
  public API for it (the AgentHandle disposer belongs to whoever created the handle), so
  the deleted session stays inert in host memory until restart. Its artifact is not
  recreated while it is idle, and `api-session/removed` drops the browser row; only a
  stale tab that resumed that exact session could later fail to append. The published
  reference plugin has the same limitation.
- Deleting the session that is currently executing the Browser request's own Agent turn
  is allowed (the host cancels it first); a richer "delete after this turn" flow is
  future work.
- Bulk cleanup UI (session age filters, multi-select purge).
