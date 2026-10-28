# Sidebar DOM reconnaissance (DSH Web 0.2.1-rc.3)

Verified with Playwright against an isolated DSH Web instance (`test/e2e/`). These
are the browser contracts the plugin relies on, recorded because the workspace
folder menu has no official extension slot and the archived filter has no public
client service.

## Sidebar session tree

| Surface | Selector / fact |
| --- | --- |
| Workspace/folder rows | `[data-row-key^="workspace:"]` (`role="treeitem"`, `data-row-key="workspace:<workspaceId>"`); the ungrouped bucket is `data-row-key="workspace:"` and has **no** menu button. |
| Workspace row actions | Last child span of the row; on hover it reveals two buttons. First = `...` actions, `aria-label="工作区“<name>”的操作"`; second = new session. Ungrouped has one button only. |
| Group section | Ancestor with inline `style="--dsh-workspace-indent: <n>px;"`. Its first `[data-row-key^="workspace:"]` descendant is the section's own workspace row (the row is wrapped in a hover-card span, so it is not a direct child). |
| Session rows | `[data-row-key^="session:"]` (`role="treeitem"`, `data-row-key="session:<sessionId>"`). |
| Archived session marker | Session row has `aria-description="已归档对话暂时无法查看，请取消归档后查看"` (localized) **and** a class token ending `_archived`. The plugin treats "has `aria-description`" as the locale-independent archived signal. |
| Blank "新会话" row | Has no action buttons; it never opens a menu. |
| Plugin seats | `div[data-slot="sidebar.session.row.leading"|"sidebar.workspaces.session.row.action"|"sidebar.workspaces.session.menu.item"]` inside the row. |

## Portaled menu cards (`Menu` / `MenuItemButton` from ui-primitives)

- Card: `[data-menu-material]` (direct child of `<body>`), contains a
  `div._material_…` plus `div[role="presentation"]` (the viewport).
- Workspace folder menu (`items` data rows): viewport children are
  `div._itemWrap_…` wrappers, each with one `button[role="menuitem"]`; text is
  `重命名` / `删除工作区` in zh.
- Session row menu (slot component rows): all rows are inside one inner wrapper
  `div` (no class) under the viewport, e.g. `置顶会话`, `重命名`, `分叉会话`,
  `归档会话`, `复制 Session ID`.
- Escape on `document` closes any open menu (`Menu` listens on document keydown).
  An outside `pointerdown` also closes it.
- Menu-surface class prefixes (`_material_`, `_viewport_`, `_itemWrap_`,
  `_label_`, `_separator_`, `_selected`) are stable suffixes; hashed prefixes
  change between builds, so the plugin never hard-codes them.

## View options (archived filter)

- Trigger: `button[aria-label="视图选项"]` (`View options` in en) in the sidebar
  section header.
- Menu rows: `隐藏已归档` (default), `全部对话（显示已归档）`,
  `仅显示已归档`.
- Selecting `全部对话（显示已归档）` renders archived rows inline (greyed, with
  the archived `aria-description`).
- The viewing store (grouping/ordering/archived filter) lives inside the
  `WorkspaceBrowser` React component and is **not** exported as a client service.
  Its write set is reachable from any row's React fiber:
  `row['__reactFiber$…'] → .return … → fiber.memoizedProps.actions`, where
  `actions = { setGroupBy, setOrderBy, setGroupExpanded, …, setArchivedFilter }`.
  The plugin walks at most 400 fibers and uses `setArchivedFilter('default' |
  'show' | 'only')`; a localized menu-click fallback covers builds where the
  fiber walk fails.
- The choice is also persisted by the app under `localStorage` key
  `dsh.workspace.view.v5`; the plugin does not write it directly.

## Deletion / refresh behaviour

- The sidebar row summary comes from the session-controller host events
  (`api-session/added|removed|…`) and the workspace `follow` stream. A host-side
  delete that detaches the session from the workspace registry **and** emits
  `api-session/removed` makes the row disappear immediately, without a reload.
  Verified in `test/e2e/run.mjs`.
- Deleting the session directory alone (without emitting the event) leaves the
  row visible until the next baseline/reload; no test relies on that path.

## First-run overlays

Isolated homes without credentials open an account modal (`button[aria-label="关闭"]`)
that intercepts pointer events. The E2E harness dismisses it before touching the
sidebar; this is test-only and unrelated to the plugin.
