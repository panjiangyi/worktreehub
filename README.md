# WorktreeHub

> 本地优先的 Git worktree 工作台：在一个网页里管理项目、分支、worktree 和真实终端。

[项目官网](https://worktreehub.mogician.me/) · [问题反馈](https://github.com/panjiangyi/worktreehub/issues)

![WorktreeHub 远程网页终端](./landing-assets/WorktreeHub-feature-remote-web-coding.png)

当你同时维护多个功能分支、修复线上问题，或让多个 AI coding 任务并行工作时，普通终端窗口很快就会失去上下文。WorktreeHub 把每个 worktree 和对应的终端会话组织在一起，让分支、目录和正在运行的任务都有明确的位置。

## 核心功能

- 在一个侧边栏中管理多个 Git 项目及其 worktree
- 创建、切换、重命名和删除 worktree
- 自动识别主分支，并支持选择基础分支创建 worktree
- 为每个项目配置 setup 脚本，新 worktree 创建后自动初始化
- 在浏览器中打开绑定到 worktree 的真实终端
- 页面刷新后恢复终端会话；浏览器断开时，后端任务继续运行
- 支持多个终端分屏，方便同时查看不同任务
- 使用 xterm.js 本地回滚缓冲，提供自然的鼠标滚轮和触屏滚动体验
- 针对手机提供方向键、`Tab`、`Esc`、`Enter`、`Ctrl+C` 等快捷按钮
- 所有项目数据保存在本地 SQLite 数据库中

## setup 脚本

新 worktree 创建完成后，通常还要重复安装依赖、复制环境变量、迁移数据库和启动开发服务。WorktreeHub 可以为每个项目保存一段 setup 脚本，并在新 worktree 中自动打开可见终端执行它。

例如：

```bash
pnpm install
cp ../main/.env.local .env.local
pnpm run db:migrate
pnpm run dev
```

脚本输出会直接显示在终端中。如果初始化失败，不会删除已经创建的 worktree，可以在终端中查看错误并继续处理。

## 环境要求

- Node.js 22 LTS，版本约束见 `.nvmrc`
- pnpm 10，推荐通过 Corepack 启用
- macOS 或 Linux；v1 暂不支持 Windows
- 本机已安装 Git

## 快速开始

```bash
git clone https://github.com/panjiangyi/worktreehub.git
cd worktreehub

corepack enable
pnpm install
cp .env.example .env
```

打开根目录下的 `.env`，至少设置登录用户名和密码：

```dotenv
WORKTREEHUB_AUTH_USERNAME=admin
WORKTREEHUB_AUTH_PASSWORD=请替换为强密码
```

启动前后端开发服务：

```bash
pnpm dev
```

- 前端开发地址：`http://127.0.0.1:5173`
- 后端地址：`http://127.0.0.1:3767`
- 只启动前端：`pnpm dev:web`
- 只启动后端：`pnpm dev:server`

## 生产构建与启动

```bash
pnpm build-and-start
```

该命令会完成构建、数据库迁移并启动服务。默认监听所有网络接口，终端会输出类似 `http://192.168.1.10:3767` 的局域网地址。

在同一 Wi-Fi 下，可以直接用手机打开该地址。生产模式下，后端会从同一个来源提供前端页面、API 和 WebSocket，移动浏览器不会错误连接到手机自己的 `127.0.0.1`。

## 远程访问

WorktreeHub 的终端由后端持有。只要后端仍在运行，即使关闭网页或切换设备，正在执行的构建、测试和脚本也不会因为浏览器断开而停止。重新打开网页后，可以继续进入原来的 worktree 上下文。

WorktreeHub 面向可信的个人开发环境。若需要从公网访问，请在前面部署 HTTPS、反向代理以及额外的访问控制，不要直接把服务端口暴露到公网。

## 常用命令

```bash
pnpm test       # 运行全部测试
pnpm typecheck  # TypeScript 类型检查
pnpm lint       # 代码检查
pnpm test:e2e   # 运行服务端端到端测试
pnpm build      # 构建全部工作区
```

## 项目结构

WorktreeHub 使用 pnpm workspace 管理四个包：

```text
worktreehub/
├── apps/
│   ├── server/       # Fastify、SQLite、node-pty 和 Git 集成（主服务）
│   ├── web/          # React、Vite、Zustand 和 xterm.js 前端
│   └── weixin-bot/   # 独立运行的微信 iLink 协议 sidecar（Hono）
├── packages/
│   └── shared/       # 前后端共享类型与 WebSocket 协议
├── build-and-start.sh
└── package.json
```

## 技术架构

### 整体架构

WorktreeHub 是「单体后端 + SPA 前端 + 独立 sidecar」的本地优先应用。核心思想是**终端会话由后端进程持有**：浏览器只是远程渲染器，页面关闭或断网不会中断正在运行的构建和脚本。

```text
┌──────────────────────────── 浏览器 (apps/web) ────────────────────────────┐
│  React 19 + Zustand stores（项目/终端/布局/认证）                            │
│  xterm.js 渲染 · react-grid-layout 终端分屏 · 移动端快捷键                   │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ REST (projects/worktrees/terminals/auth/fs/weixin)
               │ WebSocket (/ws/terminal) — attach/input/resize/close
┌──────────────▼──────────────────── 主服务 (apps/server) ──────────────────┐
│ Fastify 5                                                            │
│  routes ──► services ──► repositories (better-sqlite3)              │
│              │                                                        │
│              ├─► PtyManager (node-pty) + OutputReplayBuffer           │
│              ├─► GitService (execa, 命令允许列表)                       │
│              ├─► AuthService（会话 Cookie + 登录限流 + 同源校验）         │
│              └─► WeixinService ──► AgentRegistry（Codex/Claude Code/…）│
└──────────────┬───────────────────────────────────────────────────────────┘
               │ HTTP (长轮询 /webhook 推送)
┌──────────────▼──────────── sidecar (apps/weixin-bot) ─────────────────────┐
│ Hono REST：收发微信文本/图片 · QR 扫码登录 · 多账号 · SQLite 消息历史        │
└────────────────────────────────────────────────────────────────────────────┘
```

### 后端分层（apps/server）

- **入口与装配**：`index.ts` 读取 `config.ts`（根目录 `.env`）后调用 `app.ts` 的 `buildApp()`。`buildApp` 依次初始化数据库 → 仓储 → 服务 → 路由，构成清晰的依赖注入链。
- **请求链路**：HTTP 路由（`routes/*`）→ 服务（`modules/*`）→ 仓储（`db/repositories/*`）或底层模块（pty / git / fs）。`shared` 包中的类型被前后端同时引用，保证 API 契约一致。
- **认证钩子**：全局 `onRequest` 钩子对所有 `/api/*`（health、auth、debug 除外）强制会话校验；非 GET 请求和 `/ws/terminal` 额外做同源校验。统一 `AppError` 错误处理器把错误映射为 `{ error: { code, message } }`。
- **生产静态托管**：生产模式下用 `@fastify/static` 从同一来源提供 `web/dist`，非 API 路径回退到 `index.html`（SPA fallback），因此移动端不会误连自己设备的 `127.0.0.1`。

### 终端会话模型（核心）

- **PTY 常驻**：`PtyManager` 用 `node-pty` 以用户 shell（`xterm-256color`）在 worktree 目录中拉起进程，注入 `WORKTREEHUB_TERMINAL_ID` 等环境变量。worktree 终端是进程内长驻会话；目录终端是临时的，服务启动时清空。
- **输出回放缓冲**：每个 PTY 关联 16 MB 的 `OutputReplayBuffer`。输出写入缓冲前会剥离终端查询序列（DA 响应、OSC 10/11/12 颜色应答），避免回放时协议流量泄漏成 `1;2c`、`rgb:...` 之类的乱码。新客户端 attach 时先收到缓冲中的历史输出，实现刷新/断线后恢复画面。
- **WebSocket 协议**（`packages/shared/terminal-protocol.ts`）：客户端发送 `attach / input / resize / close / ping / paste-image`；服务端推送 `attached / output / exit / error / terminal-created / terminal-deleted / terminal-updated / pong`。同一个 PTY 允许多个客户端同时监听，输出广播给所有已 attach 的会话。
- **断线恢复**：前端 `TerminalSocket` 单例带心跳（每 30s ping，10s 无 pong 即断开）和自动重连，重连后重新 `attach` 已存在的终端；后端 PTY 进程在浏览器断开后继续运行，直到被显式关闭或进程退出。

### 数据层（apps/server）

- **存储**：`better-sqlite3` 同步驱动，默认路径 `~/.worktreehub/worktreehub.sqlite`。启动时执行 `schema.sql`（`CREATE TABLE IF NOT EXISTS`）、增量迁移（`runMigrations`，按列存在性判断）和索引创建。
- **核心表**：`projects`（项目 + setup 脚本）、`worktrees`（含 dirty / archived / merge 状态）、`terminal_sessions`（终端元数据，scope 模型区分 worktree 与 directory）；微信集成相关：`weixin_bindings`、`coding_sessions`、`coding_tasks`、`weixin_task_interactions`、`weixin_outbox` 等。

### Git 集成层

- `GitService` 通过 `execa` 调用 git，但**只允许固定命令列表**（`worktree`、`status`、`rev-parse`、`show-ref`、`branch`、`for-each-ref`、`symbolic-ref`、`merge-base`、`cherry`），不提供任意命令执行 API。
- `worktree list --porcelain` 输出由 `git.parser.ts` 解析；脏状态用 `status --porcelain` 判定；主分支通过 `origin/HEAD` 符号引用探测，回退到 `main`/`master`/当前分支。
- 合并检查（`checkBranchMergedToTarget`）先用 `merge-base --is-ancestor` 判断是否已合并，再用 `git cherry` 做补丁等价判断（区分 `merged` / `rebased` / `unmerged`）。

### 认证与安全

- 单用户用户名/密码登录，签发带过期时间的会话 Cookie（默认 12h）；开发模式只监听 `127.0.0.1`。
- 登录限流：按 IP 的失败次数统计窗口 + 全局失败上限与冷却时间，抵御暴力破解。
- 文件系统操作经 `path-safety.ts` 限制在受管理的项目与 worktree 目录内；Git 操作只接受白名单命令。
- 终端拥有当前系统用户权限，属高权限开发工具；README 明确提示公网部署需自备 HTTPS、反向代理与访问控制。

### 微信编码集成（apps/weixin-bot）

- **sidecar 职责**：`weixin-bot` 是独立进程（Hono），封装腾讯 iLink 微信 bot 协议为 REST API——收发文本/图片、QR 扫码登录、多账号隔离、按用户持久化的 SQLite 消息历史，以及带 HMAC 签名的 webhook 推送。
- **主服务侧**：`WeixinService` 以短轮询（默认 2s）拉取消息，用 `weixin_outbox` 表保证发送可靠性；`AgentRegistry` 把任务分发给 driver——内置 Codex（`codex-app-server.driver`）、Claude Code / OpenCode 等进程型 driver，以及自定义命令 driver。
- **任务与审批**：编码任务持久化为 `coding_sessions` / `coding_tasks`，`ask` 审批模式下，agent 的额外权限请求会作为 `weixin_task_interactions` 发回微信等待确认。原始终端不会转发到微信，bot 只发送任务确认、进度和整理后的结果。

### 前端（apps/web）

- **状态管理**：Zustand 拆分多个 store——`project.store`（项目/worktree 列表）、`terminal.store`（终端会话与分屏布局）、`layout.store`、`auth.store`、`theme.store`、`ui.store`。
- **终端渲染**：xterm.js（`@xterm/addon-fit` + `addon-web-links`）负责渲染与本地回滚缓冲；输入经 `ime-input` 处理中文输入法；支持剪贴板图片粘贴（`paste-image`，经服务端写入临时文件并把路径注入终端）。
- **布局**：`react-grid-layout` 实现多终端可拖拽分屏；侧边栏按项目聚合 worktree，支持创建/切换/重命名/归档与 setup 脚本初始化。

## 配置

服务端从项目根目录的 `.env` 读取配置：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `WORKTREEHUB_AUTH_USERNAME` | 无 | 登录用户名，必填 |
| `WORKTREEHUB_AUTH_PASSWORD` | 无 | 登录密码，必填 |
| `WORKTREEHUB_HOST` | `127.0.0.1` | 服务监听地址 |
| `WORKTREEHUB_PORT` | `3767` | 服务监听端口 |
| `WORKTREEHUB_DB` | `~/.worktreehub/worktreehub.sqlite` | SQLite 数据库路径 |
| `WORKTREEHUB_TRUST_PROXY` | `1` | 是否信任反向代理转发信息；设为 `0` 可关闭 |
| `WORKTREEHUB_AUTH_SESSION_TTL_MS` | `43200000` | 登录会话有效期，单位为毫秒 |
| `WORKTREEHUB_AUTH_IP_FAILURE_LIMIT` | `5` | 单个 IP 在统计窗口内允许的登录失败次数 |
| `WORKTREEHUB_AUTH_IP_WINDOW_MS` | `900000` | 单个 IP 登录失败统计窗口，单位为毫秒 |
| `WORKTREEHUB_AUTH_GLOBAL_FAILURE_LIMIT` | `10` | 全局登录失败次数限制 |
| `WORKTREEHUB_AUTH_GLOBAL_COOLDOWN_MS` | `900000` | 触发全局限制后的冷却时间，单位为毫秒 |
| `WORKTREEHUB_WEIXIN_ENABLED` | `0` | 设为 `1` 启用微信编码集成 |
| `WORKTREEHUB_WEIXIN_PORT` | `47890` | 内置 `weixin-bot-service` 监听端口 |
| `WORKTREEHUB_WEIXIN_BASE_URL` | `http://127.0.0.1:47890` | WorktreeHub 访问 sidecar 的地址 |
| `WORKTREEHUB_WEIXIN_API_KEY` | 无 | 微信 sidecar 的 API key |
| `WORKTREEHUB_WEIXIN_ACCOUNT_ID` | 无 | 用于编码消息的 bot account id |
| `WORKTREEHUB_WEIXIN_STATE_DIR` | `~/.openclaw-poc` | sidecar 会话、历史消息和媒体文件目录 |
| `WORKTREEHUB_WEIXIN_APPROVAL_MODE` | `ask` | `ask` 会把额外权限请求发回微信确认；仅在可信环境中使用 `auto` |

## 微信编码

WorktreeHub 可以通过独立运行的 `weixin-bot-service` 接收微信文本和图片，并把任务交给 Codex、Claude Code、OpenCode 或自定义命令 driver。原始终端不会转发到微信；机器人只发送任务确认、阶段进度、问题和整理后的结果。

1. 启动并登录 `weixin-bot-service`。
2. 在 WorktreeHub 根目录 `.env` 中配置微信变量并重启。`server` 和 `weixin-bot-service` 现在共用这一份配置。
3. 打开 Settings，确认 Sidecar 为 Connected，点击 Pair owner。
4. 将八位配对码发送给微信 bot，然后按编号选择项目和 worktree。

集成只允许一个已绑定的微信所有者。普通消息会成为当前 worktree 的编码任务；发送“帮助”可查看项目、工作区、助手、状态、停止和详情等控制词。

## 安全说明

- 开发模式默认只监听 `127.0.0.1`
- `pnpm build-and-start` 为局域网访问监听 `0.0.0.0`
- 服务启动必须配置单用户登录用户名和密码
- 会话 Cookie 只在当前浏览器会话中有效
- Git 操作通过允许列表执行，不提供任意命令执行 API
- 路径操作限制在受管理的项目和 worktree 目录中

应用登录只能保护 WorktreeHub 自身，不能替代公网传输加密、网络防火墙或反向代理认证。项目终端拥有当前系统用户的权限，部署时应按高权限开发工具对待。

## 许可证

MIT
