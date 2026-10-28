# 会话清理 · Session Cleaner

DeepSeek Harness Web 侧栏的会话清理插件：在会话行 `...` 菜单中**永久删除会话**，并在工作区文件夹 `...` 菜单中按工作区**显示 / 隐藏已归档会话**。

A DeepSeek Harness Web sidebar plugin: **permanently delete a session** from its row `...` menu, and **show / hide archived sessions per workspace** from the workspace folder `...` menu.

## 功能

### 删除会话

- 侧栏任意会话行 → `...` → **删除会话**（红色危险项）。
- 二次确认后，Host 会：
  1. 检查会话是否正在运行 / 被占用；
  2. 从工作区归属、置顶集合、归档集合中移除该会话；
  3. 删除 `$DSH_HOME/sessions/<project>/<session-id>/` 下的会话日志目录；
  4. 通知所有已连接的浏览器移除该行。
- 删除不可撤销，删除前请确认不再需要该会话的历史记录。
- 正在被当前进程使用的会话会拒绝删除；请切换到其他会话或重启 DSH 后删除。

### 按工作区显示归档会话

- 工作区文件夹行 → `...` → **显示归档会话 / 隐藏归档会话**，每个工作区独立开关，默认关闭，保存在浏览器 `localStorage`。
- 打开某个工作区的开关后，侧栏会切到内置的「全部对话（显示已归档）」筛选，并只在该工作区下显示已归档会话；其他工作区仍保持干净。
- 关闭最后一个开关后，恢复打开前的归档筛选状态。
- 已归档会话行保持内置的灰色样式与「取消归档」菜单，取消归档后即可正常打开使用。

## 安装

```bash
# 发布版（待发布）
dsh plugin --profile desktop add dsh-plugin-session-cleaner

# 本地开发
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

安装/更新后需要刷新 Web 页面（桌面端重启窗口）让浏览器端 bundle 重新加载。

## 兼容性

- DSH `>=0.2.1-rc.3 <0.3.0-0`（内置 workspace 菜单与 Session 存储布局按该版本实现）。
- Host 端只使用 Node 内置模块与 DSH 既有服务（`webServer`、`connection`、`sessionPersistence`、`workspaceRegistry`、`sessions`、`agents`），不引入新的运行时依赖。
- 浏览器端通过 `dsh.bundle` + `exports["./client"]` 加载，与 `@deepseek-ai/dsh-client-ui-workspace` 的 slot 契约配合。

## 实现说明

- 删除入口使用官方 slot `sidebar.workspaces.session.menu.item`（`order: 500`，`danger`）。
- 删除通过 Host 的受认证路由 `POST /api/session-cleaner/delete` 完成；该路由复用 `connection.requestRejection()` 的 Host/Origin/Cookie 校验，并在任何破坏性操作前检查会话占用与运行中的工作。
- 工作区菜单没有官方扩展 slot，因此浏览器端在菜单打开时把开关行注入 portaled 菜单卡；归档筛选通过 WorkspaceBrowser 暴露的 store actions 驱动，并以后备的菜单点击路径兜底。

## 已知限制

- 会话一旦被 DSH 打开过，就会在当前进程内保留（即使切换到其他会话也不会释放）。这类「热会话」的日志句柄仍被占用，Windows 下无法安全删除，插件会以「已被 DSH 打开并在内存中保留」提示；**重启 DSH 后再删除**即可。
- 工作区开关依赖内置的归档筛选：手动切换「视图选项 → 筛选会话」会覆盖插件当前的显示状态，下次操作开关时会重新同步。
- 工作区菜单注入依赖内置菜单的 DOM 结构与本地化标签；DSH 大版本升级后可能需要适配。

## 仓库结构

```text
client.js            浏览器端 bundle：删除会话菜单 / 确认弹窗 / 工作区归档开关
index.js             Host 入口（转出 src/host/plugin.js）
src/host/            Host 端：认证路由、会话删除、路径编码
locale/              插件市场元数据（中/英）
icon.svg             插件图标
smoke.mjs            无浏览器冒烟测试
test/host/           Host 单元测试（node:test）
test/e2e/            隔离 DSH Web 实例 + Playwright E2E / DOM 侦察
DESIGN.md            设计与团队契约（不随包发布）
```

## 开发

```bash
node smoke.mjs                 # 静态/模块冒烟测试（清单、词典、slot 注册、Host 入口）
npm test                       # Host 单元测试（node:test，32 项）
npm run setup:e2e              # 一次性：准备隔离实例（playwright-core + 会话种子 + profile）
npm run test:e2e               # 隔离 DSH Web 实例 + Playwright 端到端（7 项）
```

E2E 使用打包版 DSH 的 CLI 以 Node 身份启动**第二个** Web 实例（私有 `DSH_HOME` 位于
`.tmp-test/home`，不触碰 `~/.dsh` 与正在运行的 GUI），详见
[docs/dom-recon.md](docs/dom-recon.md) 与 `test/e2e/`。

## 许可证

MIT
