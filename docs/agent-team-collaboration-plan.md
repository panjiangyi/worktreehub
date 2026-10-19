# WorktreeHub Agent 聊天室实现计划

创建日期：2026-10-16

更新日期：2026-10-17

状态：待实施；基于当前工作区代码、已安装 CLI 的只读检查及官方文档制定。未启动模型任务或完成接入实测。

## 1. 目标与交付范围

把 WorktreeHub 扩展为可观察、可接管的本地 Agent 协作工作台。

核心用户体验：

1. 创建具名 Agent，选择 Codex、Claude Code、OpenCode 或自定义命令，并指定主职、职责范围、交付要求和工作目录。
2. 每个已启动的 Agent 对应真实的交互式 CLI 会话，运行在后端持有的 PTY 中。
3. 人和多个 Agent 在项目聊天室里交流，Agent 能向其他 Agent 提问、发送结果和交接工作。
4. 点击 Agent 的头像、名字或成员卡，打开它当前会话的真实终端，查看输出和执行过程。
5. 用户可以取得终端输入权，直接操作 CLI；浏览器刷新或关闭不终止后端会话。
6. Agent 的身份、职责、记忆和聊天记录持久化，进程退出后可以重新启动和恢复。

第一版沿用单用户、本机后端、SQLite 的产品形态；每个项目先提供一个默认聊天室，数据模型支持以后增加房间。自由讨论和协作依靠真实 CLI 内的 Agent 完成，后端负责传递消息和管理会话。

交付分为两个可验收节点：

- **核心预览版（M0—M2）**：至少两个 Codex Agent 能真实互聊；点击成员可进入各自终端；可以人工接管。
- **第一版（M0—M4）**：补齐 OpenCode、Claude Code 的适配与兼容性说明，完成投递、重启恢复和原有功能的回归。不能通过自动收信验收的运行时明确标为实验接入。

第一版同时提供可选的“协调者—执行者—审核者”团队模板，协调者也是运行真实 CLI 的普通成员；用户始终可以直接 @任意成员。模板在双 Agent 核心预览版通过后实施。

跨机器运行、多用户权限、复杂任务看板、跨组织频道、云端计费放在后续阶段。当前计划实现核心体验，不复制完整的团队 IM 产品。

## 2. 已有能力与需要调整的边界

| 当前代码 | 已有能力 | 本次处理 |
|---|---|---|
| apps/server/src/modules/pty/pty.manager.ts、pty.types.ts | node-pty、输出广播、16 MB 内存回放缓冲；底层已支持 shell / command 两种启动方式 | 复用真实 PTY；补充运行事件和受控输入入口 |
| apps/server/src/modules/terminals/terminal.service.ts | 终端元数据、worktree 关联、重启、退出处理 | 服务层目前始终启动 shell；增加持久化的启动类型与 Agent 终端生命周期 |
| apps/server/src/websocket/terminal.ws.ts | attach、input、resize、close、图片粘贴 | Agent 终端增加输入权检查、独立 detach、控制者尺寸策略 |
| apps/web/src/components/terminal/XtermView.tsx、TerminalPane.tsx | 真实终端渲染、输入、移动端操作 | 复用；支持只读观察、人工输入权和 Agent 信息 |
| apps/server/src/modules/agents/* | Codex app-server、进程型 driver、部分会话和事件归一化 | 保留已有调用路径；新增交互式运行时适配接口 |
| apps/server/src/modules/weixin/weixin.service.ts | 微信任务队列、会话恢复、审批回复 | 不直接充当聊天室服务；先共享运行占用检查，后续再接入统一协作入口 |
| apps/server/src/db/schema.sql | agent_definitions、coding_sessions、coding_tasks 等 | 新增独立协作模型，保留旧数据及 ID 语义 |
| apps/web/src/components/layout/AppLayout.tsx | 项目侧栏、worktree 标签、终端分屏 | 增加项目“聊天室”视图和 Agent 终端面板 |
| apps/web/src/stores/* | Zustand 状态管理 | 新增聊天室与 Agent 状态，适配 assistant-ui |

需要遵守的实现事实：

- 现有 ProcessAgentDriver 使用管道读取输出，CodexAppServerDriver 使用 JSON-RPC；它们不是用户能直接操作的 CLI TUI。新体验不能用这些日志模拟终端。
- 现有 PTY 和回放缓冲属于 WorktreeHub 服务进程。网页断开可以继续运行，服务重启后的旧 PTY 不能直接恢复。
- 当前 agent_definitions 更接近“运行时模板”，而不是具名团队成员。新增 Agent 成员表，避免把“Codex 这个工具”和“使用 Codex 的 Alice”混为一项。
- coding_sessions 依赖微信 binding，不能拿它作为所有聊天室成员的会话模型。
- 当前工作区已有多处未提交修改。实施时基于实时工作区核对，不回退或覆盖这些修改。

## 3. 总体架构

~~~mermaid
flowchart LR
    Human[用户] --> UI[项目聊天室与 Agent 列表]
    UI --> REST[Fastify 聊天与成员 API]
    Events[协作事件 SSE] --> UI
    REST --> Chat[协作服务]
    Chat --> DB[(SQLite)]
    Chat --> Router[消息路由与持久投递队列]
    Router --> Adapter[运行时适配器]
    Adapter --> CLI[真实 CLI 会话]
    CLI --> Bridge[本地 MCP / CLI 通信桥]
    Bridge --> IPC[本地 IPC 入口]
    IPC --> Chat
    Runtime[Agent 运行管理] --> PTY[node-pty]
    PTY --> CLI
    PTY --> WS[终端 WebSocket]
    WS --> Terminal[xterm.js 终端面板]
    Human --> Terminal
    DB --> Events
~~~

这里的“真实 CLI 会话”允许 CLI 原生的客户端/服务端结构，但终端、消息投递和会话状态必须指向同一个 nativeSessionId。不能另开隐藏的执行会话，再展示一个无关终端。

每个 Agent 最多持有一个当前运行实例；一个实例承载多轮工作。运行时本身可能包含 TUI、原生服务端和工具子进程，不能简单用“一个 PID”描述完整生命周期。

后端处理两种独立通道：

- **终端通道**：传输 PTY 原始输出、键盘输入和终端协议响应。
- **协作通道**：传输具名消息、收件箱、交接信息、成员状态和投递结果。

聊天正文由 Agent 通过通信桥主动发布。终端中的完整输出保留在执行现场；第一版不自动将所有 CLI 输出转发进群。

### 3.1 运行时适配接口

在现有 modules/agents 下新增交互式适配器，先不改变 CodingAgentDriver 的语义：

~~~ts
interface InteractiveAgentAdapter {
  probe(): Promise<RuntimeProbeResult>
  buildLaunch(context: AgentLaunchContext): CommandLaunchSpec
  bindSession(context: AgentRunContext): Promise<NativeSessionBinding>
  deliver(context: AgentRunContext, delivery: AgentDelivery): Promise<DeliveryReceipt>
  observe(context: AgentRunContext): RuntimeSubscription
  interrupt?(context: AgentRunContext): Promise<InterruptResult>
  buildResumeLaunch?(context: AgentResumeContext): CommandLaunchSpec
}
~~~

其中：

- probe 返回 CLI 版本和已验证能力，如交互终端、原生投递、状态事件、恢复、中断。
- buildLaunch 返回 executable、argv、env、cwd，交给 PTY 的 command 启动分支；不把聊天文本拼接成 shell 命令。
- bindSession 必须确认当前 TUI 对应的确切会话 ID，不能靠扫描“最新会话”猜测。
- deliver 区分运行时接受消息与 Agent 实际读取消息。
- observe 优先使用原生事件、受支持 hook 或桥接回报；缺乏证据时状态显示 unknown。
- CLI 启动配置、角色指令和桥接配置尽量限定于本次启动。保留用户原有认证，不覆盖全局配置或项目原有 AGENTS.md / CLAUDE.md。

### 3.2 各 CLI 的接入策略

检查时本机安装版本为 Codex CLI 0.163.0、Claude Code 2.1.284、OpenCode 1.18.35。这些是探测基线，尚不是通过实测的支持矩阵。

| 运行时 | 真实终端 | 入站消息候选通道 | 出站与状态 | 首要验证 |
|---|---|---|---|---|
| Codex | PTY 启动交互式 codex | 原生 queue，必要时使用同一原生服务端的控制接口 | MCP 通信桥；官方 hook 或同会话原生事件 | queue 能否唤起空闲会话、会话 ID 绑定、忙碌时队列及人工接管行为 |
| OpenCode | PTY 启动 opencode，绑定已知的本地服务端端点 | 同一会话的原生 HTTP/API | MCP / 插件及原生事件 | TUI 与 API 会话是否一致，API 版本、权限等待和恢复行为 |
| Claude Code | PTY 启动交互式 claude | 优先验证 Channels；其他方案需单独证明可用于已打开的 TUI | MCP 通信桥与生命周期 hooks | 自定义频道可用性、预览限制、空闲唤醒及审批交互 |
| 自定义命令 | executable + argv 启动 | 注册的适配器或约定协议 | 通信桥协议 | 按能力展示；仅启动成功不能标记为完整协作支持 |

Codex 官方文档及本机 help 已提供 queue（[CLI reference](https://learn.chatgpt.com/docs/cli/reference)）；OpenCode 文档提供 [TUI/服务端控制接口](https://opencode.ai/docs/server/)。[Claude Channels](https://code.claude.com/docs/en/channels) 属研究预览，自定义接入存在启用和允许列表条件；普通 MCP 本身不提供空闲会话的主动唤醒能力。因此，计划不把“MCP 可调用”直接视为“能自动收信”。

若某版本没有可靠的原生收信能力，只能将经过独立验证的 PTY 输入适配标为实验方案，严格限定于已确认的输入状态。无法判断状态时保留待投递或转人工，不能直接写入终端。

## 4. 聊天室界面与 assistant-ui

采用 **[assistant-ui](https://github.com/assistant-ui/assistant-ui) 作为首选聊天组件基础，使用 [ExternalStoreRuntime](https://www.assistant-ui.com/docs/runtimes/custom/external-store) 接入现有 Zustand 状态**。Fastify、SQLite 和协作事件仍然拥有业务状态；assistant-ui 负责呈现和输入组件。

### 4.1 页面布局

- 项目下增加“聊天室 / 工作区”切换。
- 聊天室主体展示时间线，侧边以“名字 · 主职”展示 Agent 成员，并显示运行时、工作目录和状态。
- 成员详情展示职责、交付要求、常见交接对象及实际权限能力；文字约定与已落实的权限配置分别呈现。
- 房间可配置默认接单成员。输入框提供明确的“发给默认成员”选项；普通未指定接收者的群聊仍只保存上下文，避免无意触发执行。
- 点击成员或消息作者，打开右侧 Agent 详情与真实终端；支持展开到现有终端工作区。
- 手机采用聊天室与 Agent 终端之间的全屏切换，保留返回入口。
- 切换视图、关闭面板只解除观察；停止运行是明确的独立操作。

### 4.2 assistant-ui 的使用范围

使用 Thread、[Message](https://www.assistant-ui.com/docs/primitives/message)、Composer 等 primitives 组合项目自己的 UI，并复用 Markdown、代码块、复制和滚动行为。沿用现有 React / Vite / Tailwind 风格；安装时核对 peer dependencies，锁定验证过的包版本，不使用新项目脚手架覆盖现有应用。

接入关系：

~~~text
Fastify REST + SSE
        ↓
chat.store / agent.store（业务真源在服务端）
        ↓
WorktreeHubExternalStoreAdapter
        ↓
assistant-ui primitives
~~~

不需要为了这次接入引入 assistant-cloud、另一套消息持久化或浏览器直连模型。助手的实际执行继续发生在 CLI 中。

### 4.3 多 Agent 适配规则

1. 业务消息始终保留 senderType、senderId、agentRunId、roomId、replyToMessageId、seq 和 createdAt。转换为组件格式时，Agent 消息使用 assistant role，身份放入 metadata.custom；角色类型不能代替成员身份。
2. 自定义 AgentMessage 显示名字、头像、运行时和“打开终端”。历史消息关联原运行实例；原终端不存在时展示历史状态并另给“打开当前终端”入口。
3. 使用消息转换器时明确设置 joinStrategy: "none"；实测连续两个 Agent 的消息不会合并，名字和操作入口不会互相覆盖。
4. 第一版聊天消息按完整消息发布。CLI 正在执行任务不等于聊天室正在流式生成：房间不使用一个全局 isRunning 控制全部成员和输入框。Agent 忙碌状态由独立成员状态组件显示。
5. @提及通过成员选择器生成结构化接收者 ID；输入框支持在其他 Agent 工作时继续发送，调度在后端进行。
6. 群聊回复关系由业务的 replyToMessageId 和引用组件表达。assistant-ui 的回答分支用于另一种会话语义，不能直接当作群聊的回复线程。
7. 共享聊天记录按追加事件处理；第一版提供复制、引用、重试发送等操作。编辑历史、重新生成回答和取消执行需要独立业务语义，不能直接启用单助手模板的默认行为。
8. 系统状态和投递错误使用专门组件，并验证不会被组件库过滤。点击“中断”必须指向具体 Agent / run，不能取消房间里所有成员。
9. 结构化交接和审核结论使用独立卡片，保留发送者、接收者、版本和原消息引用；卡片与普通消息共享排序和补发机制。

### 4.4 前端接入验证

先在现有应用内建立小型验证页面：同一房间连续显示两个 Agent 消息、系统事件、引用消息及终端入口；模拟两个成员同时工作；验证输入、历史分页、断线补发、移动端滚动和切换房间不串消息。

验证失败时优先缩小到 Message / Composer 等 primitives 的使用范围，保留业务协议。组件库的适配问题不应迫使后端改成单助手请求/响应模型。

## 5. 数据模型与通信协议

### 5.1 核心表

| 新增表 | 主要字段和作用 |
|---|---|
| agent_members | id、project_id、name、primary_role、responsibilities、deliverable_spec、handoff_targets、role_prompt、runtime_policy_ref、runtime_definition_id、memory_path、默认 worktree；持久成员身份 |
| agent_runs | id、agent_id、terminal_id、native_session_id、runtime_version、launch_spec、effective_policy、role_config_version、generation、运行状态、activity、control_mode、起止时间 |
| chat_rooms | id、project_id、name、default_agent_id、team_template；先创建默认房间，默认成员须属于本项目和房间 |
| chat_room_members | room_id、成员类型和成员 ID；限制接收者范围 |
| chat_messages | id、seq、room_id、发送者、agent_run_id、正文、reply_to_message_id、correlation_id、client_message_id、message_type、payload_json、created_at；支持普通消息、交接和审核结果 |
| agent_deliveries | message_id、接收 Agent、run_id、投递状态、native_request_id、租约、attempt、错误、确认时间 |
| collaboration_events | 单调递增 event_seq、项目/房间、类型和 payload；持久事件与断线补发 |
| agent_input_leases | run_id、浏览器会话/客户端、epoch、租约时间；人工输入权 |

多个接收者使用关系记录或独立 delivery，不仅存一段 @名字 文本。给每个 Agent 限制最多一个活动 run；给每个消息/接收者设置唯一约束；给客户端消息设置按发送者隔离的幂等键。

agent_definitions 暂保留为旧运行时模板表，抽出独立 repository 供新旧路径读取。微信 coding_sessions / coding_tasks 继续保存原数据，不为接入群聊而放宽 binding 外键。

成员身份使用稳定 agentId；改名不改变历史、记忆和投递关系。运行时与职责独立配置，更换 CLI 不自动继承旧运行时的会话 ID；恢复不兼容时显式新建运行并加载持久记忆。角色配置变更生成新版本，每次 run 记录已加载版本。

Agent 自有记忆目录与代码 cwd 分开：角色指令、MEMORY.md 和笔记存放在配置的应用状态目录；代码操作在 worktree 中进行。通过适配器向 CLI 明确提供目录及加载方式，并将“恢复后能读取记忆”加入验收；只创建文件夹不算完成记忆能力。

### 5.2 Web API

建议新增接口：

~~~text
GET/POST       /api/projects/:projectId/agents
PATCH          /api/agents/:agentId
POST           /api/agents/:agentId/start
POST           /api/agents/:agentId/stop
POST           /api/agents/:agentId/interrupt
POST           /api/agents/:agentId/control/acquire
POST           /api/agents/:agentId/control/release
GET/POST       /api/projects/:projectId/chat/rooms
PATCH          /api/chat/rooms/:roomId
POST           /api/chat/rooms/:roomId/team-template
GET/POST       /api/chat/rooms/:roomId/messages
GET            /api/agents/:agentId/deliveries
GET            /api/projects/:projectId/collaboration/events
~~~

发送消息先落库，同时写入事件及接收者 delivery，再提交事务；成功返回持久消息 ID。SSE 按 event_seq 补发，前端按消息 ID 去重；补取历史时合并到最新 store，避免覆盖刚到达的事件。历史消息按 seq 分页，不依赖时间戳排序。

浏览器 API 沿用现有会话与同源策略。终端继续使用现有 WebSocket；协作事件先独立使用 SSE，减少与高吞吐 PTY 输出的耦合。需要通过现有代理和会话过期验收，不能只在本机开发服务器验证。

### 5.3 Agent 通信桥

新增 packages/agent-bridge，提供 MCP stdio 服务，必要时提供等价 CLI 子命令；通过本机 Unix socket 访问协作服务。桥接入口使用每次启动签发的凭据，绑定 agentId、runId、generation 和可访问房间；身份由服务端确定。

第一版工具：

~~~text
chat_read(roomId, afterSeq, limit)
chat_send(roomId, text, recipients, replyToMessageId, clientMessageId)
chat_handoff(roomId, recipientId, goal, acceptance, artifact, evidence, clientMessageId)
chat_review(roomId, handoffMessageId, artifactVersion, verdict, findings, clientMessageId)
inbox_list()
inbox_ack(deliveryId)
agent_status(activity, relatedDeliveryId)
~~~

chat_handoff / chat_review 在 M3 加入，先使用结构化消息与引用，不依赖完整任务表。两者均由服务端校验房间成员和运行身份；审核结论必须引用交接消息与产物版本。后续完整任务系统可增加 task_claim 等工具。MCP 的工具列表负责 Agent 主动查询和发言，自动唤醒另由运行时适配器完成。

凭据不出现在聊天消息、终端标题、启动参数展示和普通事件中；服务端停止、run 结束或 generation 变化后失效。共享系统用户环境不是权限沙箱，按单用户可信本机工具的边界实现，不宣传为强隔离。

## 6. 调度、终端控制与恢复

### 6.1 消息路由

- 普通群消息作为可查询上下文保存；默认不唤醒所有 Agent。
- 人类或 Agent 的明确 @提及、指定接收者和交接消息产生 delivery，可唤醒目标成员。
- Agent 发言只唤醒被明确指定的接收者，不自动广播触发一轮所有成员回复。
- 同一 Agent 串行消费消息，忙碌时排队；各 Agent 可以并行。
- 每条协作链携带 correlationId、causedByMessageId；默认设置有限的自动唤醒次数和并发上限，达到上限后暂停并在聊天室显示原因。第一版用轮次和运行时间限制，只有运行时提供可信用量时才展示 token 统计。
- 不强制全员认领角色流程：既支持用户指定的执行/审核，也允许成员围绕同一问题讨论。
- 使用默认接单成员时，客户端明确提交接收者，服务端校验成员仍有效；默认成员失效时提示用户选择，不能静默改派。协调者模板不改变其他成员的直接收信能力。

### 6.2 可靠投递

投递状态至少区分：

~~~text
queued → submitted → acknowledged → completed
             ↘ uncertain / failed
~~~

- queued：服务端已保存，尚未提交到 CLI。
- submitted：CLI 的原生消息入口已接受；此时不能宣称 Agent 已读。
- acknowledged：Agent 在当前运行实例中通过桥接确认接收，或有可靠的原生消费事件。
- completed：这条输入关联的回合已结束；任务是否成功另行判断。
- uncertain：跨进程提交发生后失去确认，当前无法证明是否执行。

调度领取使用 SQLite 事务、租约和 generation 检查，避免重复 worker 同时投递。桥接发送使用 clientMessageId 去重；迟到的旧 run 回调不能修改新 run 状态。

SQLite 事务不能覆盖 CLI 的外部副作用。运行时支持请求幂等键时传递同一个键；不支持时，中途崩溃的投递先对账并标记 uncertain，不能无条件重试并承诺“严格执行一次”。

### 6.3 终端输入与人工接管

默认终端面板用于观察，用户点击“接管”后获得输入权。人工控制时暂停新的自动投递；正在执行的 CLI 可能继续工作，接管本身不等于中断任务。“中断当前工作”单独调用运行时能力并等待确认。

需要统一约束所有入口：

- WebSocket input、图片粘贴、程序化 writeToTerminal、适配器投递均检查当前控制模式。
- 原有 terminal close / restart / delete API 不能绕过 Agent 运行管理，避免把 Agent 重启成普通 shell。
- 使用客户端租约和 epoch 区分控制者，同一时间只允许一个浏览器客户端提交人工输入。
- 人工连接断开后暂停自动派发；明确归还控制并重新同步运行时状态后再继续，避免遗留输入被后台提交。
- 观察者仍需要发送终端查询响应；应区分用户键盘输入与受限的终端协议回复，不能因只读模式破坏 TUI 初始化。
- 多个观察视图不得互相反复改变 PTY 尺寸；选定主视图/控制者决定尺寸，其他视图适配显示。
- 关闭观察面板使用 detach，不结束 Agent。停止 Agent 通过专用操作执行并清理本次拥有的进程和桥接连接。

### 6.4 worktree 与现有任务的并发

编码成员默认分配独立 worktree。对同一规范化工作目录，增加统一的运行占用协调器；新 Agent 调度和旧微信任务均接入检查，不能各用一份内存锁。

成员间审核优先引用具体提交；未提交改动可导出带 base/head 信息的 patch 产物。审核成员在自己的目录读取固定版本，避免两个 Agent 同时修改同一工作目录。原有手动终端仍具有系统用户权限，占用协调只约束应用调度，不能将其描述成操作系统隔离。

删除项目、worktree 或终端前检查关联活动 run，先经过运行管理结束占用。历史消息和运行记录保留关联快照，避免级联删除导致记录无法解释。

### 6.5 团队模板、交接与独立审核

提供协调者、执行者、审核者三个角色模板。创建团队前展示成员和 CLI 配置；重复提交使用幂等键，不重复创建成员。协调者负责确定范围、派发、汇总和回传，后台负责消息投递与运行状态，不增加隐藏的协调模型会话。

交接卡片至少包含目标、验收条件、交付人、接收人、原消息/协作链、提交 SHA 或不可变 patch 快照，以及针对该版本的验证命令与结果。接收方通过收件箱确认接收；执行结束、审核通过和用户最终验收是不同事件。

审核成员应与执行成员分离。审核输入包含需求、固定版本的变更和测试证据，并允许查看相关代码和运行检查。新提交或新 patch 必须生成新版本引用；旧结论保留为历史，界面标为针对旧版本，不能继续显示为当前版本通过。

第一版交接状态由追加的交接、确认、审核和用户反馈事件推导，服务端校验允许的转换；模型正文不能直接覆盖状态。完整任务依赖与看板留给后续阶段。审核通过只更新审核结论，合并和发布根据用户明确指令执行。

### 6.6 工作约定与执行权限

角色说明中的约定注入 CLI，实际权限由适配器、CLI 原生策略、目录与凭据范围、仓库规则落实。run 保存请求策略与实际生效能力的结果；不支持的限制显式标注，不能将一段“只读”提示词展示为强制只读。

通信桥只能约束经桥接执行的动作，不能单靠桥接拦截原生 shell 的全部行为。保留用户已有授权，不根据名字、职级或团队模板自动扩大权限；具体策略以用户配置与 CLI 能力为准。

### 6.7 运行状态与服务重启

分别维护：

- processStatus：starting / online / stopped / exited / disconnected / failed。
- activity：idle / working / waiting_permission / waiting_input / unknown。
- controlMode：managed / manual。

有进程不等于正在工作，没有输出也不代表空闲；状态来自适配器的可验证事件。[Codex hooks](https://learn.chatgpt.com/docs/hooks)、[Claude hooks](https://code.claude.com/docs/en/hooks) 和 [OpenCode 插件事件](https://opencode.ai/docs/plugins/) 可作为不同运行时的候选事件源，按安装版本验证。

恢复原则：

1. 浏览器刷新：重新 attach 当前 terminal，补取事件；不启动第二个 CLI。
2. CLI 退出：保留 Agent 身份、记忆、会话引用和聊天历史；记录退出原因，提供重新启动。
3. WorktreeHub 重启：旧 PTY 的内存回放不视为可恢复资源。对原生后台仍可能存活的会话先查询与对账，确认后重连或恢复；无法确认则进入 disconnected / uncertain，停止自动派发。
4. 恢复使用明确的 nativeSessionId；不能用“恢复最近一个会话”代替 Agent 与会话的一一绑定。
5. 正常关闭服务时停止调度、处理租约和桥接，再关闭数据库。只清理本应用拥有的进程/线程，不终止用户共享的原生 daemon 或其他 CLI 会话。

第一版不承诺 WorktreeHub 服务重启期间 PTY 无缝存活。需要该能力时另做独立会话 supervisor 或 tmux 方案，并验证原生 CLI 的实际进程结构。

## 7. 分阶段实施

### M0：验证真实 CLI 与聊天室桥接可行性

先完成最小技术验证，输出运行时版本、启动参数、会话绑定、投递和恢复的实测记录。

工作项：

- 在 PTY 中启动一个真实 Codex TUI，确定启动到 nativeSessionId 的绑定流程。
- 向空闲、忙碌及等待审批的同一会话投递消息；验证排队、执行和终端可见性。
- 通过最小桥接工具让 Agent 向一个本地消息存储发送结构化消息，验证身份归属。
- 探测 OpenCode 当前 API 与 Claude Channels 的实际启用条件；不以最新网页文档替代本机能力测试。
- 在现有 React 应用中验证 assistant-ui：两个不同作者的连续消息、运行中继续发送、终端入口和房间切换。
- 明确各运行时的普通启动、人工接管、停止与恢复边界。

验收：证明“看到的终端”和“收发消息的 Agent”属于同一实际会话；至少 Codex 的单会话闭环通过。输出支持矩阵，未经验证的能力保持待验证标记。

### M1：Agent 成员、真实终端及生命周期

工作项：

- 新增 Agent 成员/运行实例模型、增量迁移、repository 和共享类型；包括主职、职责、交付要求、交接对象及角色版本。
- 抽出运行时模板读取逻辑，保留旧 driver 和微信 ID。
- TerminalService 增加 command 启动及启动配置持久化，复用 PtyManager。
- 新增 AgentRuntimeService 与 Codex 交互式适配器。
- 加入终端观察/接管/归还、输入租约及 run 结束事件。
- 对关闭、重启、删除、图片粘贴和程序输入统一检查。
- 将微信任务接入公共 worktree 占用检查，保护新旧执行路径。
- 前端提供创建成员、启动、停止、状态及“打开终端”入口；使用稳定成员 ID，展示请求策略与实际权限能力。

验收：同一项目可启动两个独立 Agent，分别进入真实 Codex TUI；刷新不新建进程；关闭面板不停止运行；重启 Agent 正确恢复指定会话或明确报告无法恢复。

### M2：聊天室与双 Agent 自动互聊

工作项：

- 新增房间、消息、投递、持久事件及桥接凭据。
- 实现 chat / inbox 工具、默认 @路由、单 Agent 队列、幂等及协作链轮次上限。
- 实现 REST 历史查询、发送消息和 SSE 增量/补发。
- 新增 Zustand stores、assistant-ui external-store adapter 和自定义作者组件。
- 实现 @成员输入、引用、投递状态、成员列表、终端面板与移动端切换。
- 将角色指令和记忆目录注入 CLI；指令明确何时回复、何时交接、何时保持沉默。

验收：用户 @Alice 提出问题，Alice 能 @Bob 请求检查，Bob 自动收到并在聊天室回复，Alice 可以继续回应；整个过程无需人工逐个切换终端转发。两人的消息均有正确身份和终端入口；忙碌时仍可发送；达到轮次上限会暂停。

这是第一个可以日常试用的核心预览版。

### M3：多运行时与团队交付模板

工作项：

- 按 M0 结果实现 OpenCode 交互式适配器、同会话 API 投递及状态事件。
- 实现 Claude 的双向桥接、状态回报和经过验证的收信方式；Channels 的预览/账号限制在创建成员时明确显示。
- 每个适配器记录支持的版本与能力；检测到不兼容版本时降级或停止自动投递。
- 新增自定义 executable / argv 模板和适配能力声明，区分“终端可运行”和“完整协作可用”。
- 验证不同运行时的角色指令、MCP 配置、用户原有登录和记忆加载不会相互污染。

- 在双 Agent 预览版通过后，加入可选的协调者/执行者/审核者模板与默认接单成员；保持直接 @收信。
- 实现交接/审核消息类型、桥接工具与卡片，使用固定提交或不可变 patch 引用。
- 实现跨成员审核校验、按版本归属的结论和退回修改流程；不依赖完整任务看板。

验收：至少 Codex 与 OpenCode 的异构对话通过，Claude 按实测能力通过同一套验收或明确标为实验接入；协调者模板完成派发、交付、独立审核与一次退回修改，各成员均能打开真实终端。用户直接 @执行者仍然可用。

### M4：可靠性、回归与第一版交付

工作项：

- 覆盖消息入库、原生提交前后、确认前后崩溃的恢复和去重。
- 完成原生后台存活检查、服务重启对账、旧回调隔离、租约失效及不确定投递处理。
- 检查同 worktree 的新旧调度占用、项目删除和终端管理入口；覆盖成员改名、角色配置变更及审核版本失效。
- 验证会话过期、SSE 重连、代理部署和多浏览器观察/接管。
- 完成迁移兼容、旧终端分屏、目录终端、setup 脚本和微信编码的回归。
- 增加运行时支持说明、启动/退出/恢复说明与最小示例。

验收：第 8 节的关键场景全部通过；支持矩阵区分已验证、实验和不支持，第一版交付范围有明确证据。

### 后续阶段：按实际使用补充

- 完整任务领取、依赖、状态看板和跨任务验收；复用第一版的交接与审核消息，不另建冲突的状态真源。
- 微信作为聊天室的另一个入口，支持按 Agent / 房间选择目标；逐步迁移原执行路径，不一次性删除旧历史。
- 多房间、长期记忆整理和协作链成本观测。
- 记忆备份：先提供带格式版本、配置和技能引用的本地导出与恢复；排除凭据及 CLI 登录状态，远端备份单独配置。
- 共享技能：真实流程验证后沉淀，run 记录加载版本；执行中的成员不自动切换版本。
- 定时任务：保存成功游标，按变化触发通知；无新增内容时保持安静，限制重复唤醒。
- 独立会话 supervisor、多机器节点和更细的执行隔离。

## 8. 关键验收场景

| 场景 | 预期结果 |
|---|---|
| 创建两个同为 Codex 的不同成员 | 两个身份、两个明确会话和对应终端；不共享错误的“最近会话” |
| 成员改名或角色配置更新 | agentId 与历史引用不变，活动 run 的已加载配置版本可追溯 |
| 可选协调者模板 | 派发、交付、独立审核、退回修改形成闭环，各成员都有真实终端 |
| 直接 @非协调者 | 成员正常收到，无需通过协调者转发 |
| 审核后产物变更 | 原结论保留且标记旧版本，新版本不能沿用通过状态 |
| 角色声明只读但 CLI 无法落实 | 显示约定与能力差异，不报告为已强制只读 |
| Alice @Bob | Bob 收到指定消息并回复；聊天室中可辨认两位作者 |
| Codex 与 OpenCode 协作 | 两者实际执行并通过同一个房间交换消息 |
| 连续多个 Agent 消息 | assistant-ui 不合并作者，不丢名字或终端链接 |
| A 工作时用户继续发言 | 输入可用，新消息持久排队，B 可独立工作 |
| 用户查看终端 | 内容来自该 run 的真实 PTY，切换视图不重建进程 |
| 用户接管及断线 | 自动投递暂停；另一客户端不能抢写；不会断线后自动提交残留输入 |
| 只读终端初始化 | 必需的终端协议回复仍可发送，TUI 显示正常 |
| CLI 等待权限 | 按原生权限交互处理，不把聊天文本误当批准输入 |
| 发送请求重试 / SSE 重放 | 消息按稳定 ID 去重，收件人 delivery 不重复创建 |
| 原生接受后服务崩溃 | 对账或标记 uncertain；不盲目重复执行 |
| CLI 退出或服务重启 | 真实状态可见，绑定正确恢复，聊天/记忆保留，无重复会话 |
| 打开历史作者的终端入口 | 显示对应历史 run；不会误指向另一个 Agent 或新进程 |
| 删除使用中的 worktree | 先经运行管理处理占用，避免进程在已删除目录继续工作 |
| 微信任务遇到 Agent 已占用目录 | 排队或返回明确占用状态，两条调度路径不并行写入 |
| 无人追加指令 | 队列最终静止；成员不会互相无限唤醒 |

实现阶段的检查：

- 后端使用现有 Vitest 验证事务、投递状态、恢复对账和输入权，不调用真实付费模型。
- 用可控的交互式测试进程验证 PTY、退出、重启和控制权；这种测试不替代真实 CLI 冒烟。
- 前端验证身份转换、分页与实时合并、不同房间隔离、接管状态和成员入口。
- 每种声明支持的 CLI 至少完成一次真实端到端冒烟，记录版本、会话 ID 和结果。
- 代码完成后运行 pnpm typecheck、pnpm test、pnpm test:e2e、pnpm build，并核对现有失败与新增失败。

## 9. 预计修改位置

| 区域 | 修改或新增 |
|---|---|
| packages/shared/src | Agent 成员/运行实例、聊天室、投递与协作事件类型；终端协议补充 |
| packages/agent-bridge | 新包：MCP stdio、CLI 工具与本地 IPC 客户端 |
| apps/server/src/db | 协作表、迁移、索引及对应 repositories |
| apps/server/src/modules/agents | 交互式适配接口、运行管理、Codex / OpenCode / Claude 实现 |
| apps/server/src/modules/collaboration | 房间、消息、收件箱、投递、事件、占用协调、团队模板、交接/审核版本校验与 IPC 入口 |
| apps/server/src/modules/terminals | command 启动、Agent 终端策略和输入权 |
| apps/server/src/modules/pty | 必需的生命周期事件及进程管理能力 |
| apps/server/src/modules/weixin | 公共占用检查；后续统一消息入口 |
| apps/server/src/routes、websocket、app.ts | 新 API / SSE 装配、终端策略与关闭顺序 |
| apps/web/src/components/chat、agents | 聊天室、成员列表、消息作者、角色配置、交接/审核卡片、Agent 详情与终端容器 |
| apps/web/src/stores、api | 聊天/Agent store、external-store adapter、API 与事件订阅 |
| apps/web/src/components/layout、terminal | 视图切换、观察模式和终端接管 |
| apps/web/package.json、pnpm-lock.yaml | 锁定通过验证的 assistant-ui 依赖 |

当前只新增此计划文档。实施从 M0 开始，先证明真实 CLI 的同会话收发与 assistant-ui 的多作者显示，再按各里程碑推进。

## 10. 参考与本次修订

参考：[Soren 的 Grok Bot 团队实践](https://x.com/Eileeness160708/status/2111043448866484505)，关联长文《从0-1通过Grok Bot，组建属于我自己的“梁山好汉”》。原文提供个人使用经验，未展示底层实现。

2026-10-17 已将借鉴点纳入正文：第 4 节的角色展示与交接卡片，第 5 节的数据及工具协议，第 6 节的团队模板、独立审核和权限边界，第 7—8 节的工作项及验收。记忆备份、版本化技能和安静的定时任务保持后续范围。
