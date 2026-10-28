# dsh-plugin-session-cleaner — internal design / team contract

Status: working notes for the build. Not shipped in the npm package. Keep this file
updated when a contract changes.

## Goal

One DSH bundle plugin that adds two sidebar features to the DeepSeek Harness Web GUI:

1. **Delete session** — the session row `...` menu (`sidebar.workspaces.session.menu.item`)
   gets a destructive **删除会话** item. Confirming permanently removes the session
   log from disk and all workspace/global bookkeeping, so the row disappears for good.
2. **Per-workspace archived-session visibility** — the workspace folder row `...` menu
   (rename / delete workspace) gets a **显示归档会话 / 隐藏归档会话** toggle, default
   off, persisted per workspace. When on, that workspace's archived sessions are shown
   in its section of the sidebar session list.

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
- `session/invalid` — malformed/unsafe id
- `session/not-found` — no stored session with that id
- `session/live` — session is currently live in this process (agent/session store hit)
- `session/active` — `workspace/session-activity` reported running work; `details.activity`
  is the same array shape the workspace archive confirmation uses
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
- session directory = `<root>/<projectKey(cwd)>/<encodeSegment(id)>`. Copy the two
  encoder helpers from `dsh-session-persistence-jsonl` (they are module-private) — see
  the reference implementation quoted in `src/host/encoding.js` (host-engineer writes
  it; unit-test against the real names in the installed asar if convenient).
- `cwd === undefined` → project dir `_no-cwd`.
- `sessions` / `agents` services: `ctx.get('sessions')?.get(id)` or
  `ctx.get('agents')?.get(id)` non-undefined → `session/live` (do NOT delete under a
  writer; Windows cannot remove the open artifact anyway).
- activity: `await ctx.waterfall('workspace/session-activity', { sessionId })`; non-empty
  → `session/active` with `details.activity`.
- remove references before files:
  - `registry = ctx.get('workspaceRegistry')`; for every `registry.list()` entity whose
    `sessionIds.includes(id)` call `entity.detachSession(id)` (method exists at runtime
    even though the public TS interface hides it).
  - `await registry.unarchiveSession(id)` and `await registry.unpinSession(id)`
    (both are idempotent / no existence check).
- `fs.rm(sessionDir, { recursive: true, force: true })`
- `ctx.emit('api-session/removed', id)` so every connected browser drops the summary row.
- response `{ok:true}`.

The plugin must not crash the host: wrap the whole handler; log with `ctx.logger`.

## Feature 2 — client workspace menu (Lead)

`dsh-client-ui-workspace` hard-codes its workspace folder menu (`rename`, `delete`) and
declares no slot for it. There is no supported slot to extend it, so the client half
augments the DOM:

- Identify workspace `...` triggers by `[data-row-key^="workspace:"]` row + the
  `aria-label` built from the workspace locale template `actions.workspace.aria`
  (`ctx.locale.bind('workspace')`), so it stays locale-safe.
- On trigger click, watch for the portaled menu card (`[data-menu-material]`) and append a
  React-rendered `MenuItemButton` row (primitives are ModuleLoader baseline externals:
  `require('@deepseek-ai/dsh-client-ui-primitives')`).
- Toggle state per workspace id in `localStorage` (`sessionCleaner.showArchived.<id>`),
  default off.
- When at least one workspace is on, drive the built-in archived filter to
  `show` by activating the sidebar view-options menu item (localized via the `workspace`
  namespace: `viewOptions.label`, `viewOptions.showArchived`), then hide the `.archived`
  session rows of workspaces whose toggle is off (inline `display:none`, re-applied from a
  `MutationObserver`). Turning the last toggle off restores the filter to `default`.
- Closing the workspace menu after our item is chosen: dispatch an `Escape` keydown on
  `document` (the Menu primitive listens document-level); fall back to an outside
  `pointerdown`.

## Feature 1 — client side (Lead)

- Locale namespace `sessionCleaner`.
- Menu item: `ctx.slots.inject('sidebar.workspaces.session.menu.item', ...)` with
  `id: 'session-cleaner.delete'`, `order: 500`, `danger`, `separatorBefore`; gets
  `sessionId`/`displayTitle` and the slot-level `useMenuOpenState` hook.
- Confirmation: one `shell.overlay` registration rendering a body-portaled `Modal`
  (primitives) with the target title; confirm calls the host route with
  `fetch('/api/session-cleaner/delete', ...)`; success shows a `Toast`; failure shows
  localized messages by error code (`session/live`, `session/active`, …).
- Before calling the host, capture the workspace id from the client `workspaces` service;
  after success, if the deleted session was the main-view session, open a fresh session
  in that workspace via `ctx.get('uiWorkspace').startSession(workspaceId)`.
- Keep the plugin bundle self-contained: no new runtime npm dependencies in `client.js`.

## Test plan

- `node smoke.mjs` — static/module smoke: package manifest, locale key parity, host
  entry exports, client bundle loads with a fake `window.__ModuleLoader__` + require map,
  inject list sanity.
- `node --test test/host` — host unit tests with a fake ctx (temp sessions root).
- test-infra: isolated second DSH Web instance under `.tmp-test/` (separate `DSH_HOME`,
  copied `sessions/` + `storages/workspace.json` seed data), Playwright against the
  printed authenticated URL; verifies DOM recon + both features end-to-end.

## Implementation status (final, this build)

- Feature 1 (delete session) is implemented and verified end-to-end:
  slot row -> confirmation Modal -> authenticated host route -> bookkeeping
  detach + log-directory removal + `api-session/removed` broadcast. The row
  disappears without a page reload, the toast shows, workspace/archive/pin
  bookkeeping and the session directory are gone (asserted in
  `test/e2e/run.mjs`).
- Feature 2 (per-workspace archived visibility) is implemented and verified:
  DOM-augmented workspace menu row (between rename and delete), React fiber
  access to `actions.setArchivedFilter`, per-workspace hiding via inline
  `display:none`, persisted to `localStorage`, restored after reload.
- Tests: `node smoke.mjs` 8/8, `npm test` 32/32, `npm run test:e2e` 7/7
  (isolated second Web instance, Playwright).
- Known limitation: a session that DSH has opened stays live in the host
  process even after navigating away (verified by probe), so the host refuses
  its deletion with `session/live`. The client surfaces a clear restart
  instruction. Restarting DSH makes the session cold and deletable. A
  restart-deferred deletion queue is possible future work, see "Deferred".
- Recon facts the implementation depends on are recorded in
  `docs/dom-recon.md`; if a future DSH build changes the workspace menu DOM or
  the WorkspaceBrowser props, that file is the first place to update.

### Deferred (not in this build)

- Restart-deferred deletion for live/current sessions: persist a pending id,
  detach + emit handled immediately, purge the log directory on the next host
  start, and hide the pending row from later baselines. Needs a pending store
  plus a client pending-list read; deliberately out of scope for the first
  shipping cut because it can leave a ghost row after a browser reload.
- Bulk cleanup UI (session age filters, multi-select purge).
