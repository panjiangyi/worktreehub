import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import type { TerminalService } from '../modules/terminals/terminal.service.js'
import type { PtyManager } from '../modules/pty/pty.manager.js'
import type { createProjectRepository } from '../db/repositories/project.repository.js'
import type { createWorktreeRepository } from '../db/repositories/worktree.repository.js'
import { AppError } from '../utils/app-error.js'

export function authenticateExternalTerminalRequest(request: FastifyRequest): void {
  const token = process.env.WORKTREEHUB_API_TOKEN
  if (!token || token.length < 32) throw new AppError('API_DISABLED', 'External API is disabled', 503)
  const authorization = request.headers.authorization ?? ''
  const digest = (value: string) => createHash('sha256').update(value).digest()
  if (!timingSafeEqual(digest(authorization), digest('Bearer ' + token))) {
    throw new AppError('AUTH_REQUIRED', 'Valid API token required', 401)
  }
}

const filterSchema = z.object({
  projectId: z.string().min(1).optional(),
  worktreeId: z.string().min(1).optional(),
}).strict()
const positive = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(1000000))
const bufferSchema = z.object({
  tail: positive.optional(),
  start: positive.optional(),
  end: positive.optional(),
}).strict().refine(q => q.tail !== undefined ? q.start === undefined && q.end === undefined :
  (q.start === undefined && q.end === undefined) || (q.start !== undefined && q.end !== undefined && q.start <= q.end),
  'Use tail or an inclusive start/end range')
const inputSchema = z.union([
  z.object({ text: z.string().max(65536), submit: z.boolean().default(false) }).strict(),
  z.object({ key: z.enum(['ENTER', 'CTRL_C', 'ESC', 'TAB', 'UP', 'DOWN', 'LEFT', 'RIGHT']) }).strict(),
])
const keys = { ENTER: '\r', CTRL_C: '\x03', ESC: '\x1b', TAB: '\t', UP: '\x1b[A', DOWN: '\x1b[B', LEFT: '\x1b[D', RIGHT: '\x1b[C' } as const

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new AppError('VALIDATION_ERROR', result.error.message)
  return result.data
}

export async function registerExternalTerminalRoutes(
  app: FastifyInstance,
  terminals: TerminalService,
  pty: PtyManager,
  projects: ReturnType<typeof createProjectRepository>,
  worktrees: ReturnType<typeof createWorktreeRepository>,
) {
  app.get('/api/v1/terminals', async request => {
    const query = parse(filterSchema, request.query)
    return { terminals: terminals.listTerminals().filter(t =>
      t.status === 'running' && pty.has(t.id) &&
      (!query.projectId || t.projectId === query.projectId) &&
      (!query.worktreeId || t.worktreeId === query.worktreeId)
    ).map(t => ({
      ...t,
      projectName: t.projectId ? projects.findById(t.projectId)?.name ?? null : null,
      branch: t.worktreeId ? worktrees.findById(t.worktreeId)?.branch ?? null : null,
    })) }
  })
  app.get<{ Params: { terminalId: string } }>('/api/v1/terminals/:terminalId/buffer', async request => {
    const id = request.params.terminalId
    const query = parse(bufferSchema, request.query)
    const runtime = pty.get(id)
    if (!runtime) throw new AppError('PTY_NOT_FOUND', 'Running terminal not found', 404)
    const raw = runtime.outputBuffer.toString()
    // Physical LF-delimited replay lines, not rendered terminal screen rows.
    const lines = raw === '' ? [] : raw.split('\n')
    const start = query.tail !== undefined ? Math.max(0, lines.length - query.tail) : (query.start ?? 1) - 1
    const end = Math.min(lines.length, query.end ?? lines.length)
    return { terminalId: id, format: 'raw', totalLines: lines.length, start: start < end ? start + 1 : null,
      end: start < end ? end : null, content: lines.slice(start, end).join('\n') }
  })
  app.post<{ Params: { terminalId: string } }>('/api/v1/terminals/:terminalId/input', async (request, reply) => {
    const id = request.params.terminalId
    const input = parse(inputSchema, request.body)
    if (!pty.has(id)) throw new AppError('PTY_NOT_FOUND', 'Running terminal not found', 404)
    const data = 'key' in input ? keys[input.key] : input.text + (input.submit ? '\r' : '')
    terminals.writeToTerminal(id, data)
    return reply.code(204).send()
  })
}
