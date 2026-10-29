# 会话清理 · Session Cleaner

DeepSeek Harness Web 侧栏的会话清理插件：在会话行 `...` 菜单中**永久删除会话**，并在工作区文件夹 `...` 菜单中按工作区**显示 / 隐藏已归档会话**。

A DeepSeek Harness Web sidebar plugin: **permanently delete a session** from its row `...` menu, and **show / hide archived sessions per workspace** from the workspace folder `...` menu.

## 功能

### 删除会话

- 侧栏任意会话行 → `...` → **删除会话**（红色危险项）。
- 二次确认后，Host 会：
  1. 若该会话正在运行，先停止它的 Agent（最多等待 8 秒；停不下来则拒绝删除且不改动任何内容）；
  2. 从工作区归属、置顶集合、归档集合中移除该会话；
  3. 删除 `$DSH_HOME/sessions/<project>/<session-id>/` 下的会话日志目录；
  4. 删除投影缓存 `$DSH_HOME/storages/session_projcache/sessions/<session-id>.json`（以及派生的搜索索引，存在时）；
  5. 通知所有已连接的浏览器移除该行。
- 删除不可撤销，删除前请确认不再需要该会话的历史记录。
- DSH 打开过的会话（包括当前主视图里的会话）也可以直接删除，无需重启：Windows 上日志文件以 `FILE_SHARE_DELETE` 打开、写锁是内核信号量而非文件锁，因此打开状态下也能移除；删除当前会话后客户端会自动新建一个空会话。只有在运行中的 Agent 无法在限时内停止时才会拒绝（提示先停止该会话的工作）。
- 会话 ID 支持 DSH 的完整形态：`session-<uuid>`、旧版 `sess_<uuid>` 与子代理的裸 `<uuid>`。

### 按工作区显示归档会话

- 工作区文件夹行 → `...` → **显示归档会话 / 隐藏归档会话**，每个工作区独立开关，默认关闭，保存在浏览器 `localStorage`（键 `dsh.session-cleaner.workspace-archived`，值 `{"enabled":{"<workspaceId>":true}}`）。
- 打开某个工作区的开关后，侧栏会切到内置的「全部对话（显示已归档）」筛选，并只在该工作区下显示已归档会话；其他工作区与「未分组」的归档会话保持隐藏。
- 关闭最后一个开关后，内置筛选会切回「隐藏已归档」，并且插件用注入的 CSS + 行属性隐藏所有已归档行 —— 即使内置筛选此前被手动设为「显示已归档」或页面重载，也不会再冒出来。
- 隐藏不依赖 React 重渲染：行标记是插件自有属性（`data-session-cleaner-archived-hidden`），配合 `!important` 规则，列表重新渲染/虚拟滚动不会让隐藏的归档行重新出现。
- 已归档会话行保持内置的灰色样式与「取消归档」菜单；要取消归档，先打开该工作区的开关让它显示出来再操作（插件开启时会接管归档筛选）。

## 安装

**远程安装（推荐，其他人也适用）**：DeepSeek Harness Desktop →「插件」页 →「添加插件」，
输入下面的 git 规格（安装器接受 `github:` 简写、仓库 URL 或 tarball 地址），确认后
**完全退出并重启应用**：

```text
github:gcggcg/dsh-plugin-session-cleaner
# 或
https://github.com/gcggcg/dsh-plugin-session-cleaner
```

插件不需要构建步骤：安装器 clone 仓库后，Host 入口 `index.js` 与浏览器 bundle
`client.js` 会被直接加载。

Desktop 的 profile 由 Electron 应用独占管理，`dsh plugin --profile desktop ...` 会被拒绝。
其余安装方式按环境选择：

```bash
# Desktop（本地开发）：退出应用后，在 <DSH_HOME>\profiles\desktop\package.json 的
#   dependencies 加 "dsh-plugin-session-cleaner": "link:<本仓库绝对路径>"，
#   并把它追加到 dsh.profile.bundles；然后在 profile 目录用应用自带的 pnpm 执行
#   `pnpm install`（或直接使用「插件」页的安装功能），重新打开应用。
#   注意：<DSH_HOME> 默认是 %USERPROFILE%\.dsh；如果应用设置了 DSH_HOME
#   环境变量（部分安装/测试环境会用一个独立的数据目录），插件必须装到
#   **该目录**下的 profiles\desktop，否则重启后不会出现。

# Web / TUI profile（CLI 管理）
dsh plugin --profile web add github:gcggcg/dsh-plugin-session-cleaner
dsh plugin --profile web add link:<本仓库绝对路径>     # 本地开发
```

安装/更新后需要**完全退出并重启 DeepSeek Harness Desktop**（或刷新 Web 页面）让浏览器端 bundle 重新加载。

## 兼容性

- DSH `>=0.2.1-rc.3 <0.3.0-0`（内置 workspace 菜单与 Session 存储布局按该版本实现）。
- Host 端只使用 Node 内置模块与 DSH 既有服务（`webServer`、`connection`、`sessionPersistence`、`workspaceRegistry`、`sessions`、`agents`），不引入新的运行时依赖。
- 浏览器端通过 `dsh.bundle` + `exports["./client"]` 加载，与 `@deepseek-ai/dsh-client-ui-workspace` 的 slot 契约配合。

## 实现说明

- 删除入口使用官方 slot `sidebar.workspaces.session.menu.item`（`order: 500`，`danger`）。
- 删除通过 Host 的受认证路由 `POST /api/session-cleaner/delete` 完成；该路由复用 `connection.requestRejection()` 的 Host/Origin/Cookie 校验，并在任何破坏性操作前停止运行中的 Agent、检查残留活动（`workspace/session-activity`）。
- 工作区菜单没有官方扩展 slot，因此浏览器端在菜单打开时把开关行注入 portaled 菜单卡；归档筛选通过 WorkspaceBrowser 暴露的 store actions 驱动（`setArchivedFilter`），并以后备的菜单点击路径兜底。
- 归档可见性由插件完全接管：有任一工作区开关时筛选为 `show`、只显示已启用工作区的归档行；全部关闭时筛选为 `default` 并隐藏所有归档行。

## 已知限制

- 已打开但空闲的会话被删除后，Host 内存里的 Session 对象仍会保留到重启（DSH 没有公开的释放接口），但磁盘日志不会重建、侧栏行会立即消失；只有仍停在旧标签页里并继续写入该会话的极端情况可能写入失败。发布版参考实现同样有此限制。
- 删除正在运行该会话 Agent 的操作会先停止 Agent；若限时内停不下来则整次删除中止（不删任何内容）。
- 插件开启期间会接管内置归档筛选：全部开关关闭时，「视图选项 → 全部对话（显示已归档）」不再显示归档会话；这是「默认关闭」需求的直接结果。要查看/取消归档某个归档会话，先打开对应工作区的开关。
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
npm test                       # Host 单元测试（node:test，44 项）
npm run setup:e2e              # 一次性：准备隔离实例（playwright-core + 会话种子 + profile）
npm run test:e2e               # 隔离 DSH Web 实例 + Playwright 端到端（11 项：冷/热会话删除、归档显示/隐藏等）
npm run test:desktop           # 可选：真实 Desktop 外壳（dsh-app://app）7 项检查，缺少打包应用时自动 SKIP
```

E2E 使用打包版 DSH 的 CLI 以 Node 身份启动**第二个** Web 实例（私有 `DSH_HOME` 位于
`.tmp-test/home`，不触碰 `~/.dsh` 与正在运行的 GUI），详见
[docs/dom-recon.md](docs/dom-recon.md) 与 `test/e2e/`。

`npm run test:desktop` 会以**独立 `--user-data-dir` 与独立 `DSH_HOME`** 启动第二个 Desktop
实例（真正的 `dsh-app://app` 页面），复现/验证「打开过的会话也能删除」和「归档会话按工作区
显示/隐藏」；它只读用户真实 profile 并复制到 `.tmp-test/`，绝不触碰正在运行的 Desktop 应用。

## 许可证

MIT
