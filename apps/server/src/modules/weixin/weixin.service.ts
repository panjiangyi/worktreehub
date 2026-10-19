import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomInt } from 'node:crypto'
import { nanoid } from 'nanoid'
import type { createProjectRepository } from '../../db/repositories/project.repository.js'
import type { createWorktreeRepository } from '../../db/repositories/worktree.repository.js'
import type { WeixinRepository, CodingTaskRecord, TaskInteraction } from '../../db/repositories/weixin.repository.js'
import type { WorktreeService } from '../worktrees/worktree.service.js'
import type { ProjectService } from '../projects/project.service.js'
import type { AgentRegistry } from '../agents/agent.registry.js'
import type { AgentEvent } from '../agents/agent.types.js'
import type { AppConfig } from '../../config.js'
import { WeixinClient, type WeixinMessage, type WeixinMedia } from './weixin.client.js'
import { chunks, cleanAgentText, summarizeFinal } from './message.formatter.js'

type ProjectRepo = ReturnType<typeof createProjectRepository>
type WorktreeRepo = ReturnType<typeof createWorktreeRepository>
type Pairing = { code: string; expiresAt: number } | null

const HELP = `可发送编码任务，也可以发送以下关键词：
项目 / 切换项目
工作区 / 切换工作区
新建工作区
助手 / 切换助手
状态
停止
查看详情
新会话
帮助`

export function createWeixinService(deps: {
  config: AppConfig
  repo: WeixinRepository
  projectRepo: ProjectRepo
  worktreeRepo: WorktreeRepo
  worktreeService: WorktreeService
  projectService: ProjectService
  agents: AgentRegistry
}) {
  const { config, repo, projectRepo, worktreeRepo, worktreeService, projectService, agents } = deps
  const client = new WeixinClient(config.weixin)
  const mediaDir = path.join(os.homedir(), '.worktreehub', 'weixin-media')
  fs.mkdirSync(mediaDir, { recursive: true, mode: 0o700 })
  const controllers = new Map<string, AbortController>()
  const activeDrivers = new Map<string, ReturnType<AgentRegistry['get']>>()
  const activeRuns = new Map<string, Promise<void>>()
  let pairing: Pairing = null
  let stopped = true
  let pollTimer: NodeJS.Timeout | null = null
  let outboxTimer: NodeJS.Timeout | null = null
  let interactionTimer: NodeJS.Timeout | null = null
  let pollAbort: AbortController | null = null
  let pollPromise: Promise<void> | null = null
  let outboxPromise: Promise<void> | null = null
  let lastError: string | null = null

  const enqueueText = (userId: string, text: string) => {
    const pieces = chunks(text)
    for (const [index, part] of pieces.entries()) {
      const content = pieces.length > 1 ? `[${index + 1}/${pieces.length}]\n${part}` : part
      repo.enqueueOutbox({ id: `out_${nanoid()}`, accountId: config.weixin.accountId, userId, kind: 'text', payload: { text: content } })
    }
    requestOutboxFlush()
  }

  function requestOutboxFlush(): void {
    if (outboxPromise) return
    const promise = flushOutbox().catch((error) => {
      lastError = `微信 outbox 异常：${(error as Error).message}`
    }).finally(() => {
      if (outboxPromise === promise) outboxPromise = null
    })
    outboxPromise = promise
  }

  async function flushOutbox(): Promise<void> {
    if (!config.weixin.enabled || !config.weixin.apiKey || !config.weixin.accountId) return
    for (const item of repo.claimPendingOutbox()) {
      try {
        if (item.kind === 'text') await client.sendText(item.userId, String(item.payload.text ?? ''))
        else await client.sendFile(item.userId, String(item.payload.path), String(item.payload.filename), String(item.payload.mime))
        repo.markOutboxSent(item.id)
      } catch (error) {
        lastError = (error as Error).message
        repo.markOutboxFailed(item.id, item.attempts + 1, lastError)
      }
    }
  }

  function expireTaskInteractions(): void {
    for (const interaction of repo.expireTaskInteractions()) {
      const controller = controllers.get(interaction.worktreeId)
      if (controller && !controller.signal.aborted) controller.abort('interaction-timeout')
    }
  }

  function projectMenu(bindingId: string, userId: string): void {
    const projects = projectRepo.findAll()
    if (!projects.length) { enqueueText(userId, 'WorktreeHub 中还没有项目，请先在网页添加。'); return }
    repo.setPending(bindingId, 'select_project', { ids: projects.map((p) => p.id) })
    enqueueText(userId, `请选择项目：\n${projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}`)
  }

  function worktreeMenu(bindingId: string, userId: string, projectId: string): void {
    const project = projectRepo.findById(projectId)
    const worktrees = worktreeRepo.findByProjectId(projectId)
    if (!project || !worktrees.length) { enqueueText(userId, '这个项目没有可用的 worktree。'); return }
    repo.setPending(bindingId, 'select_worktree', { projectId, ids: worktrees.map((w) => w.id) })
    enqueueText(userId, `请选择 ${project.name} 的工作区：\n${worktrees.map((w, i) => `${i + 1}. ${w.displayName || w.name}${w.isDirty ? '（有修改）' : ''}`).join('\n')}`)
  }

  function agentMenu(bindingId: string, userId: string): void {
    const available = agents.list().filter((agent) => agent.enabled)
    repo.setPending(bindingId, 'select_agent', { ids: available.map((agent) => agent.id) })
    enqueueText(userId, `请选择 coding agent：\n${available.map((agent, i) => `${i + 1}. ${agent.name}`).join('\n')}`)
  }

  async function saveMedia(message: WeixinMessage): Promise<string[]> {
    if (!message.media || message.media.type !== 'image') return []
    const bytes = await client.downloadMedia(message.media)
    const extension = extensionFor(message.media)
    const filePath = path.join(mediaDir, `${config.weixin.accountId.replace(/[^a-zA-Z0-9_-]/g, '_')}-${message.seq}${extension}`)
    fs.writeFileSync(filePath, Buffer.from(bytes), { mode: 0o600 })
    return [filePath]
  }

  function extensionFor(media: WeixinMedia): string {
    if (media.mime === 'image/jpeg') return '.jpg'
    if (media.mime === 'image/webp') return '.webp'
    if (media.mime === 'image/gif') return '.gif'
    return '.png'
  }

  async function submitTask(bindingId: string, userId: string, text: string, seq: number, imagePaths: string[]): Promise<void> {
    const binding = repo.getBinding()
    const worktree = binding?.activeWorktreeId ? worktreeRepo.findById(binding.activeWorktreeId) : null
    if (!binding || !worktree) { projectMenu(bindingId, userId); return }
    const agentId = binding.activeAgentId
    const driver = agents.get(agentId)
    if (imagePaths.length && !driver.capabilities.has('images')) {
      enqueueText(userId, `${driver.definition.name} 不支持图片输入。请切换助手或补充文字描述。`)
      return
    }
    let session = repo.getSession(binding.id, worktree.id, agentId)
    const timestamp = new Date().toISOString()
    if (!session) {
      session = { id: `session_${nanoid()}`, bindingId: binding.id, worktreeId: worktree.id, agentId,
        providerSessionId: null, status: 'ready', createdAt: timestamp, updatedAt: timestamp }
      repo.insertSession(session)
    }
    const task: CodingTaskRecord = { id: `task_${nanoid()}`, sessionId: session.id, sourceMessageSeq: seq,
      prompt: text || '请分析附图并处理其中展示的问题。', imagePaths, status: 'queued', summary: null, detail: null,
      error: null, startedAt: null, completedAt: null, createdAt: timestamp, updatedAt: timestamp }
    if (!repo.insertTask(task)) {
      enqueueText(userId, '这条微信消息已经接收过，无需重复提交。')
      return
    }
    enqueueText(userId, `已收到任务 ${task.id.slice(-6)}。\n工作区：${worktree.displayName || worktree.name}\n助手：${driver.definition.name}${controllers.has(worktree.id) ? '\n当前工作区忙碌，任务已排队。' : ''}`)
    startWorker(worktree.id)
  }

  function startWorker(worktreeId: string): void {
    if (stopped || activeRuns.has(worktreeId)) return
    const promise = runNext(worktreeId).catch((error) => {
      lastError = `微信任务 worker 异常：${(error as Error).message}`
    }).finally(() => {
      activeRuns.delete(worktreeId)
      if (!stopped && repo.listQueuedWorktreeIds().includes(worktreeId)) startWorker(worktreeId)
    })
    activeRuns.set(worktreeId, promise)
  }

  async function runNext(worktreeId: string): Promise<void> {
    const run = repo.claimNextQueuedTask(worktreeId)
    if (!run) return
    const worktree = worktreeRepo.findById(worktreeId)
    const session = repo.getSession(run.bindingId, worktreeId, run.agentId)
    if (!worktree || !session) {
      repo.updateTask(run.id, { status: 'failed', error: '任务关联的工作区或会话已经不存在。', completedAt: new Date().toISOString() })
      enqueueText(run.userId, `任务 ${run.id.slice(-6)} 失败：关联的工作区或会话已经不存在。`)
      return
    }
    const controller = new AbortController(); controllers.set(worktreeId, controller)
    let detail = ''
    let lastProgressAt = 0
    try {
      const driver = agents.get(run.agentId)
      activeDrivers.set(worktreeId, driver)
      repo.updateSession(session.id, { status: 'running' })
      const result = await driver.run({ cwd: worktree.path, prompt: run.prompt, providerSessionId: session.providerSessionId,
        imagePaths: run.imagePaths, approvalMode: config.weixin.approvalMode, signal: controller.signal, onEvent: async (event: AgentEvent) => {
          if (event.type === 'session') repo.updateSession(session.id, { providerSessionId: event.sessionId })
          if (event.type === 'message') detail += `${event.text}\n`
          if (event.type === 'progress' && Date.now() - lastProgressAt > 120_000) {
            lastProgressAt = Date.now(); enqueueText(run.userId, `[${run.id.slice(-6)}] ${event.message}`)
          }
          if (event.type === 'question') {
            repo.updateTask(run.id, { status: 'waiting' })
            repo.setTaskInteraction({ id: `interaction_${nanoid()}`, bindingId: run.bindingId, taskId: run.id, worktreeId,
              kind: 'question', agentInteractionId: event.id, payload: { text: event.text, options: event.options ?? [] } })
            enqueueText(run.userId, `[任务 ${run.id.slice(-6)} 需要你回答]\n${event.text}${event.options?.length ? `\n${event.options.map((o, i) => `${i + 1}. ${o}`).join('\n')}` : ''}`)
          }
          if (event.type === 'approval') {
            if (config.weixin.approvalMode === 'auto') driver.resolveInteraction?.(event.id, '1')
            else {
              repo.updateTask(run.id, { status: 'waiting' })
              repo.setTaskInteraction({ id: `interaction_${nanoid()}`, bindingId: run.bindingId, taskId: run.id, worktreeId,
                kind: 'approval', agentInteractionId: event.id, payload: { text: event.text } })
              enqueueText(run.userId, `[任务 ${run.id.slice(-6)} 请求额外权限]\n${event.text}\n\n1. 同意本次\n2. 拒绝`)
            }
          }
        } })
      const final = cleanAgentText(result.finalMessage)
      repo.updateSession(session.id, { providerSessionId: result.providerSessionId, status: 'ready' })
      repo.updateTask(run.id, { status: 'completed', summary: final, detail: result.detail || detail, completedAt: new Date().toISOString() })
      for (const part of summarizeFinal(`任务 ${run.id.slice(-6)} 已完成。\n\n${final}`)) enqueueText(run.userId, part)
    } catch (error) {
      const cancelled = controller.signal.aborted
      const timedOut = controller.signal.reason === 'interaction-timeout'
      repo.updateSession(session.id, { status: 'ready' })
      repo.updateTask(run.id, { status: cancelled ? 'cancelled' : 'failed', error: (error as Error).message,
        completedAt: new Date().toISOString() })
      enqueueText(run.userId, timedOut ? `任务 ${run.id.slice(-6)} 等待回复超时，已停止。`
        : cancelled ? `任务 ${run.id.slice(-6)} 已停止。` : `任务 ${run.id.slice(-6)} 失败：${(error as Error).message.slice(0, 700)}`)
    } finally {
      controllers.delete(worktreeId)
      activeDrivers.delete(worktreeId)
      repo.closeTaskInteractions(run.id)
    }
  }

  function selectTaskInteraction(interactions: TaskInteraction[], text: string): { interaction: TaskInteraction; answer: string } | null {
    if (interactions.length === 1) return { interaction: interactions[0], answer: text }
    const match = text.trim().match(/^([A-Za-z0-9_-]{6})\s+([\s\S]+)$/)
    if (!match) return null
    const interaction = interactions.find((item) => item.taskId.endsWith(match[1]))
    return interaction ? { interaction, answer: match[2].trim() } : null
  }

  async function handleTaskInteraction(bindingId: string, userId: string, text: string): Promise<boolean> {
    const interactions = repo.listPendingTaskInteractions(bindingId)
    if (!interactions.length) return false
    const selected = selectTaskInteraction(interactions, text)
    if (!selected) {
      enqueueText(userId, `有多个任务正在等你回复，请使用“任务号 回答”：\n${interactions.map((item) =>
        `${item.taskId.slice(-6)} ${item.kind === 'approval' ? '权限确认' : String(item.payload.text ?? '问题')}`).join('\n')}`)
      return true
    }
    const { interaction } = selected
    let answer = selected.answer
    if (interaction.kind === 'approval' && !['1', '2'].includes(answer.trim())) {
      enqueueText(userId, `任务 ${interaction.taskId.slice(-6)}：请回复 1 表示同意本次，或回复 2 拒绝。`)
      return true
    }
    const options = Array.isArray(interaction.payload.options) ? interaction.payload.options.map(String) : []
    const choice = Number(answer.trim())
    if (interaction.kind === 'question' && options.length && Number.isInteger(choice) && choice >= 1 && choice <= options.length) {
      answer = options[choice - 1]
    }
    const driver = activeDrivers.get(interaction.worktreeId)
    if (!driver?.resolveInteraction) {
      repo.closeTaskInteractions(interaction.taskId)
      enqueueText(userId, `任务 ${interaction.taskId.slice(-6)} 已不在运行，这条回复没有提交。请重新发送任务。`)
      return true
    }
    driver.resolveInteraction(interaction.agentInteractionId, answer)
    repo.resolveTaskInteraction(interaction.id, answer)
    repo.updateTask(interaction.taskId, { status: 'running' })
    enqueueText(userId, interaction.kind === 'approval'
      ? (answer.trim() === '1' ? '已同意本次操作，任务继续。' : '已拒绝这次额外权限。')
      : `已将回答交给任务 ${interaction.taskId.slice(-6)}。`)
    return true
  }

  async function handlePending(bindingId: string, userId: string, text: string, seq: number, images: string[]): Promise<boolean> {
    const pending = repo.getPending(bindingId)
    if (!pending) return false
    const choice = Number(text.trim())
    if (pending.kind === 'active_message') {
      if (![1, 2].includes(choice)) { enqueueText(userId, '请回复 1 或 2。'); return true }
      repo.clearPending(bindingId)
      if (choice === 1) await submitTask(bindingId, userId, String(pending.payload.text), Number(pending.payload.seq), pending.payload.images as string[] ?? [])
      else enqueueText(userId, '已取消这条消息。')
      return true
    }
    const ids = pending.payload.ids as string[] | undefined
    if (ids) {
      if (!Number.isInteger(choice) || choice < 1 || choice > ids.length) { enqueueText(userId, `请输入 1 到 ${ids.length}。`); return true }
      const id = ids[choice - 1]; repo.clearPending(bindingId)
      if (pending.kind === 'select_project') { repo.updateBindingContext({ projectId: id, worktreeId: null }); worktreeMenu(bindingId, userId, id); return true }
      if (pending.kind === 'select_worktree') {
        const worktree = worktreeRepo.findById(id)!; repo.updateBindingContext({ projectId: worktree.projectId, worktreeId: id })
        enqueueText(userId, `已切换到：${worktree.displayName || worktree.name}\n现在可以直接发送编码任务。`); return true
      }
      if (pending.kind === 'select_agent') {
        repo.updateBindingContext({ agentId: id }); enqueueText(userId, `已切换到 ${agents.list().find((a) => a.id === id)?.name ?? id}。`); return true
      }
      if (pending.kind === 'create_worktree_project') {
        const branches = await projectService.listBranches(id)
        const refs = [...branches.local, ...branches.remote].filter((ref, index, all) => all.indexOf(ref) === index)
        if (!refs.length) { enqueueText(userId, '这个项目没有可用的基础分支。'); return true }
        repo.setPending(bindingId, 'create_worktree_base', { projectId: id, ids: refs })
        enqueueText(userId, `请选择基础分支：\n${refs.map((ref, i) => `${i + 1}. ${ref}`).join('\n')}`)
        return true
      }
      if (pending.kind === 'create_worktree_base') {
        repo.setPending(bindingId, 'create_worktree_name', { projectId: pending.payload.projectId, baseRef: id })
        enqueueText(userId, '请输入新分支名，例如 feature/weixin-login：')
        return true
      }
    }
    if (pending.kind === 'create_worktree_name') {
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(text) || text.includes('..') || text.endsWith('/')) {
        enqueueText(userId, '分支名格式无效，请使用字母、数字、点、短横线、下划线或斜杠。'); return true
      }
      repo.setPending(bindingId, 'create_worktree_confirm', { ...pending.payload, branch: text })
      enqueueText(userId, `请确认创建：\n分支：${text}\n基础：${pending.payload.baseRef}\n\n1. 确认创建\n2. 取消`)
      return true
    }
    if (pending.kind === 'create_worktree_confirm') {
      if (![1, 2].includes(choice)) { enqueueText(userId, '请回复 1 或 2。'); return true }
      repo.clearPending(bindingId)
      if (choice === 2) { enqueueText(userId, '已取消创建。'); return true }
      try {
        enqueueText(userId, '正在创建 worktree。')
        const worktree = await worktreeService.createWorktree(String(pending.payload.projectId), {
          branch: String(pending.payload.branch), baseRef: String(pending.payload.baseRef),
        })
        repo.updateBindingContext({ projectId: worktree.projectId, worktreeId: worktree.id })
        enqueueText(userId, `创建成功并已切换到：${worktree.displayName || worktree.name}`)
      } catch (error) { enqueueText(userId, `创建失败：${(error as Error).message}`) }
      return true
    }
    return false
  }

  async function handleOwnerMessage(message: WeixinMessage): Promise<void> {
    const binding = repo.getBinding()!
    const text = message.text.trim()
    const images = await saveMedia(message).catch((error) => { enqueueText(binding.userId, `图片下载失败：${(error as Error).message}`); return [] })
    if (await handleTaskInteraction(binding.id, binding.userId, text)) return
    if (await handlePending(binding.id, binding.userId, text, message.seq, images)) return
    if (text === '帮助') { enqueueText(binding.userId, HELP); return }
    if (text === '项目' || text === '切换项目') { projectMenu(binding.id, binding.userId); return }
    if (text === '工作区' || text === '切换工作区') {
      if (!binding.activeProjectId) projectMenu(binding.id, binding.userId)
      else worktreeMenu(binding.id, binding.userId, binding.activeProjectId)
      return
    }
    if (text === '助手' || text === '切换助手') { agentMenu(binding.id, binding.userId); return }
    if (text === '状态') {
      const worktree = binding.activeWorktreeId ? worktreeRepo.findById(binding.activeWorktreeId) : null
      const running = repo.getRunningTask()
      enqueueText(binding.userId, `当前工作区：${worktree?.displayName || worktree?.name || '未选择'}\n助手：${binding.activeAgentId}\n任务：${running ? `${running.id.slice(-6)} ${running.status}` : '空闲'}`)
      return
    }
    if (text === '停止') {
      if (binding.activeWorktreeId && controllers.get(binding.activeWorktreeId)) { controllers.get(binding.activeWorktreeId)!.abort(); enqueueText(binding.userId, '正在停止当前任务。') }
      else enqueueText(binding.userId, '当前工作区没有运行中的任务。')
      return
    }
    if (text === '查看详情') {
      const session = binding.activeWorktreeId ? repo.getSession(binding.id, binding.activeWorktreeId, binding.activeAgentId) : null
      const task = session ? repo.getLatestTask(session.id) : repo.getLatestTask()
      if (!task) enqueueText(binding.userId, '还没有任务记录。')
      else for (const part of chunks(task.detail || task.summary || task.error || '没有可显示的详情。')) enqueueText(binding.userId, part)
      return
    }
    if (text === '新会话') {
      if (!binding.activeWorktreeId) { projectMenu(binding.id, binding.userId); return }
      if (controllers.has(binding.activeWorktreeId)) { enqueueText(binding.userId, '请先停止或等待当前任务完成。'); return }
      repo.resetSession(binding.id, binding.activeWorktreeId, binding.activeAgentId); enqueueText(binding.userId, '已创建新的对话上下文。')
      return
    }
    if (text === '新建工作区') {
      const projects = projectRepo.findAll(); repo.setPending(binding.id, 'create_worktree_project', { ids: projects.map((p) => p.id) })
      enqueueText(binding.userId, `请选择项目：\n${projects.map((p, i) => `${i + 1}. ${p.name}`).join('\n')}`); return
    }
    if (!binding.activeWorktreeId) { projectMenu(binding.id, binding.userId); return }
    if (controllers.has(binding.activeWorktreeId)) {
      await submitTask(binding.id, binding.userId, text, message.seq, images)
      return
    }
    await submitTask(binding.id, binding.userId, text, message.seq, images)
  }

  async function processMessage(message: WeixinMessage): Promise<void> {
    if (message.direction !== 'in' || repo.isProcessed(config.weixin.accountId, message.seq)) return
    const binding = repo.getBinding()
    if (!binding) {
      if (pairing && Date.now() < pairing.expiresAt && message.text.trim() === pairing.code) {
        const timestamp = new Date().toISOString()
        repo.bind({ id: `wx_${nanoid()}`, accountId: config.weixin.accountId, userId: message.user, displayName: null,
          activeProjectId: null, activeWorktreeId: null, activeAgentId: 'codex', createdAt: timestamp, updatedAt: timestamp })
        pairing = null
        enqueueText(message.user, `绑定成功。\n\n${HELP}`)
        projectMenu(repo.getBinding()!.id, message.user)
      }
      repo.markProcessed(config.weixin.accountId, message.seq)
      return
    }
    if (message.user !== binding.userId || message.user === '') {
      repo.markProcessed(config.weixin.accountId, message.seq)
      return
    }
    await handleOwnerMessage(message)
    repo.markProcessed(config.weixin.accountId, message.seq)
  }

  async function poll(): Promise<void> {
    if (stopped || !config.weixin.enabled) return
    pollAbort = new AbortController()
    try {
      let cursor = repo.getCursor(config.weixin.accountId)
      let page
      do {
        page = await client.messages(cursor, 200, pollAbort.signal)
        for (const message of page.messages) await processMessage(message)
        cursor = page.next_cursor
        repo.setCursor(config.weixin.accountId, cursor)
      } while (page.has_more && !stopped)
      lastError = null
    } catch (error) {
      if (!stopped || (error as Error).name !== 'AbortError') lastError = (error as Error).message
    } finally {
      pollAbort = null
    }
    if (!stopped) pollTimer = setTimeout(() => { pollPromise = poll() }, config.weixin.pollIntervalMs)
  }

  function cleanupMedia(): void {
    const deadline = Date.now() - config.weixin.mediaRetentionMs
    for (const entry of fs.readdirSync(mediaDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      const file = path.join(mediaDir, entry.name)
      try { if (fs.statSync(file).mtimeMs < deadline) fs.unlinkSync(file) } catch { /* best effort */ }
    }
  }

  return {
    start() {
      if (!config.weixin.enabled || !stopped) return
      cleanupMedia(); stopped = false
      for (const task of repo.recoverInterruptedTasks()) {
        enqueueText(task.userId, `任务 ${task.id.slice(-6)} 因 WorktreeHub 重启已安全中止，没有自动重放。请重新发送任务以重试。`)
      }
      for (const worktreeId of repo.listQueuedWorktreeIds()) startWorker(worktreeId)
      pollPromise = poll(); outboxTimer = setInterval(requestOutboxFlush, 2000)
      interactionTimer = setInterval(expireTaskInteractions, 5000)
    },
    async stop() {
      stopped = true
      if (pollTimer) clearTimeout(pollTimer)
      if (outboxTimer) clearInterval(outboxTimer)
      if (interactionTimer) clearInterval(interactionTimer)
      pollAbort?.abort()
      for (const controller of controllers.values()) controller.abort()
      await Promise.allSettled(activeRuns.values())
      await pollPromise
      await outboxPromise
    },
    createPairingCode() {
      const code = String(randomInt(10000000, 100000000))
      pairing = { code, expiresAt: Date.now() + 10 * 60_000 }
      return { code, expiresAt: new Date(pairing.expiresAt).toISOString() }
    },
    unbind() {
      for (const controller of controllers.values()) controller.abort()
      repo.unbind()
      pairing = null
    },
    async status() {
      const remote = config.weixin.enabled && config.weixin.apiKey && config.weixin.accountId
        ? await client.status() : { connected: false, account: null }
      const binding = repo.getBinding(); const task = repo.getRunningTask()
      return {
        enabled: config.weixin.enabled,
        configured: Boolean(config.weixin.apiKey && config.weixin.accountId), connected: remote.connected,
        accountId: remote.account?.id ?? (config.weixin.accountId || null), accountLabel: remote.account?.label ?? null,
        pollerState: remote.account?.poller?.state ?? null,
        owner: binding ? { userId: binding.userId, displayName: binding.displayName } : null,
        pairing: pairing && Date.now() < pairing.expiresAt ? { code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() } : null,
        activeProjectId: binding?.activeProjectId ?? null, activeWorktreeId: binding?.activeWorktreeId ?? null,
        activeAgentId: binding?.activeAgentId ?? 'codex', approvalMode: config.weixin.approvalMode, agents: agents.list(),
        currentTask: task ? { id: task.id, status: task.status, prompt: task.prompt, summary: task.summary, error: task.error,
          worktreeId: task.worktreeId, agentId: task.agentId, createdAt: task.createdAt, completedAt: task.completedAt } : null,
        lastError,
      }
    },
    listAgents() { return agents.list() },
    upsertAgent(definition: import('@worktreehub/shared').AgentDefinition) { repo.upsertAgent(definition) },
    agentHealth() { return agents.health() },
  }
}

export type WeixinService = ReturnType<typeof createWeixinService>
