import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { AgentDefinition } from '@worktreehub/shared'
import type { AgentRunInput, AgentRunResult, CodingAgentDriver } from './agent.types.js'

type RpcMessage = { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } }
type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout }
type PendingInteraction = { rpcId: string | number; kind: 'approval' | 'question'; questionIds?: string[] }

export class CodexAppServerDriver implements CodingAgentDriver {
  readonly capabilities
  private process: ChildProcessWithoutNullStreams | null = null
  private rpcId = 0
  private rpc = new Map<string | number, PendingRpc>()
  private interactions = new Map<string, PendingInteraction>()

  constructor(readonly definition: AgentDefinition) {
    this.capabilities = new Set(definition.capabilities)
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    return await new Promise((resolve) => {
      const child = spawn(this.definition.executable, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.once('error', (error) => resolve({ ok: false, detail: error.message }))
      child.once('exit', (code) => {
        const detail = output.trim() || `exit ${code}`
        const match = detail.match(/(\d+)\.(\d+)\.(\d+)/)
        const compatible = !match || Number(match[1]) > 0 || Number(match[2]) >= 144
        resolve({ ok: code === 0 && compatible, detail: compatible ? detail : `${detail} (requires Codex CLI 0.144+)` })
      })
    })
  }

  private send(message: RpcMessage): void {
    if (!this.process) throw new Error('Codex app-server is not running')
    this.process.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = ++this.rpcId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.rpc.delete(id)
        reject(new Error(`Codex RPC timed out: ${method}`))
      }, 30_000)
      this.rpc.set(id, { resolve, reject, timeout })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timeout)
        this.rpc.delete(id)
        reject(error)
      }
    })
  }

  resolveInteraction(id: string, answer: string): void {
    const pending = this.interactions.get(id)
    if (!pending) return
    this.interactions.delete(id)
    if (pending.kind === 'approval') {
      const accepted = answer === '1' || /同意|允许|accept|approve/i.test(answer)
      this.send({ id: pending.rpcId, result: { decision: accepted ? 'accept' : 'decline' } })
      return
    }
    const answers = Object.fromEntries((pending.questionIds ?? []).map((questionId) => [questionId, { answers: [answer] }]))
    this.send({ id: pending.rpcId, result: { answers } })
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (this.process) throw new Error('This Codex driver already has an active turn')
    const child = spawn(this.definition.executable, ['app-server'], {
      cwd: input.cwd, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.process = child
    let stderr = ''
    let detail = ''
    let finalMessage = ''
    let threadId = input.providerSessionId
    let turnId: string | null = null
    let settled = false
    let complete!: (value: AgentRunResult) => void
    let fail!: (error: Error) => void
    const completion = new Promise<AgentRunResult>((resolve, reject) => {
      complete = (result) => { if (!settled) { settled = true; resolve(result) } }
      fail = (error) => { if (!settled) { settled = true; reject(error) } }
    })

    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.once('error', fail)
    child.once('exit', (code) => {
      if (!settled) fail(new Error(code && code !== 0
        ? `Codex app-server exited ${code}: ${stderr.slice(-1000)}`
        : 'Codex app-server exited before the turn completed'))
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      detail += `${line}\n`
      let message: RpcMessage
      try { message = JSON.parse(line) as RpcMessage } catch { return }
      if (message.id !== undefined && !message.method) {
        const pending = this.rpc.get(message.id)
        if (pending) {
          this.rpc.delete(message.id)
          clearTimeout(pending.timeout)
          if (message.error) pending.reject(new Error(message.error.message ?? 'Codex RPC failed'))
          else pending.resolve(message.result)
        }
        return
      }
      if (message.id !== undefined && message.method) {
        const params = message.params ?? {}
        if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          if (input.approvalMode === 'auto') {
            this.send({ id: message.id, result: { decision: 'accept' } })
            return
          }
          const interactionId = `approval_${String(message.id)}`
          this.interactions.set(interactionId, { rpcId: message.id, kind: 'approval' })
          const command = typeof params.command === 'string' ? `\n命令：${params.command}` : ''
          const cwd = typeof params.cwd === 'string' ? `\n目录：${params.cwd}` : ''
          void input.onEvent({ type: 'approval', id: interactionId, text: `${String(params.reason ?? 'Codex 请求额外权限')}${command}${cwd}` })
          return
        }
        if (message.method === 'item/tool/requestUserInput') {
          const questions = Array.isArray(params.questions) ? params.questions as Array<Record<string, unknown>> : []
          const interactionId = `question_${String(message.id)}`
          const questionIds = questions.map((q) => String(q.id))
          this.interactions.set(interactionId, { rpcId: message.id, kind: 'question', questionIds })
          const text = questions.map((q) => String(q.question ?? '')).join('\n')
          const options = questions.flatMap((q) => Array.isArray(q.options)
            ? (q.options as Array<Record<string, unknown>>).map((o) => String(o.label ?? '')) : [])
          void input.onEvent({ type: 'question', id: interactionId, text, options })
          return
        }
        this.send({ id: message.id, error: { message: `Unsupported server request: ${message.method}` } } as RpcMessage)
        return
      }
      if (message.method === 'item/agentMessage/delta') {
        const delta = String(message.params?.delta ?? '')
        finalMessage += delta
      } else if (message.method === 'item/started') {
        void input.onEvent({ type: 'progress', message: 'Codex 正在处理任务。' })
      } else if (message.method === 'turn/started') {
        const turn = message.params?.turn as Record<string, unknown> | undefined
        if (turn?.id) turnId = String(turn.id)
      } else if (message.method === 'turn/completed') {
        const turn = message.params?.turn as Record<string, unknown> | undefined
        const status = String(turn?.status ?? 'completed')
        if (status === 'failed') fail(new Error(String((turn?.error as Record<string, unknown> | undefined)?.message ?? 'Codex turn failed')))
        else complete({ providerSessionId: threadId, finalMessage: finalMessage.trim() || '任务已完成。', detail })
      }
    })

    const abort = () => {
      if (threadId && turnId) void this.request('turn/interrupt', { threadId, turnId }).catch(() => undefined)
      setTimeout(() => child.kill('SIGTERM'), 1000).unref()
    }
    input.signal.addEventListener('abort', abort, { once: true })

    try {
      await this.request('initialize', {
        clientInfo: { name: 'worktreehub_weixin', title: 'WorktreeHub WeChat', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      })
      this.send({ method: 'initialized', params: {} })
      const threadResult = await this.request(threadId ? 'thread/resume' : 'thread/start', threadId
        ? { threadId, cwd: input.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' }
        : { cwd: input.cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' }) as { thread?: { id?: string } }
      threadId = threadResult.thread?.id ?? threadId
      if (!threadId) throw new Error('Codex did not return a thread id')
      await input.onEvent({ type: 'session', sessionId: threadId })
      const turnResult = await this.request('turn/start', {
        threadId,
        cwd: input.cwd,
        approvalPolicy: 'on-request',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [input.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
        input: [
          { type: 'text', text: input.prompt, text_elements: [] },
          ...input.imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
        ],
      }) as { turn?: { id?: string } }
      if (turnResult.turn?.id) turnId = turnResult.turn.id
      return await completion
    } finally {
      input.signal.removeEventListener('abort', abort)
      for (const pending of this.rpc.values()) {
        clearTimeout(pending.timeout)
        pending.reject(new Error('Codex app-server stopped'))
      }
      this.rpc.clear(); this.interactions.clear(); this.process = null
      child.kill('SIGTERM')
    }
  }
}
