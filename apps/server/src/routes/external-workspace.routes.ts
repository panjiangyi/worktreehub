import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ProjectService } from '../modules/projects/project.service.js'
import type { WorktreeService } from '../modules/worktrees/worktree.service.js'
import type { TerminalService } from '../modules/terminals/terminal.service.js'
import type { createWorktreeRepository } from '../db/repositories/worktree.repository.js'
import { AppError } from '../utils/app-error.js'

const safeRef = z.string().trim().min(1).max(1024).refine(
  value => !value.startsWith('-') && !/[\x00-\x20\x7f]/u.test(value),
  'Git ref must not begin with a dash or contain whitespace or control characters'
)
const branchName = safeRef.refine(value =>
  value !== '@' && !value.includes('..') && !value.includes('@{') &&
  !/[~^:?*\[\\]/u.test(value) &&
  value.split('/').every(part => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock')) &&
  !value.endsWith('.'),
  'Invalid Git branch name'
)
const title = z.string().trim().min(1).max(200).refine(
  value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value),
  'Title must not contain control characters'
)
const createWorktreeSchema = z.object({
  branch: branchName,
  baseRef: safeRef.optional(),
  name: title.optional(),
}).strict()
const createTerminalSchema = z.object({
  title: title.optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(200).optional(),
  initialCommand: z.string().max(65536).optional(),
}).strict()
const emptyQuery = z.object({}).strict()

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data)
  if (!result.success) throw new AppError('VALIDATION_ERROR', result.error.message)
  return result.data
}

// Registered in the same Fastify scope as the external terminal API,
// which installs the Bearer authentication and no-store response hook.
export async function registerExternalWorkspaceRoutes(
  app: FastifyInstance,
  projects: ProjectService,
  worktrees: WorktreeService,
  terminals: TerminalService,
  worktreeRepo: ReturnType<typeof createWorktreeRepository>,
) {
  function requireProject(id: string) {
    const project = projects.listProjects().find(item => item.id === id)
    if (!project) throw new AppError('PROJECT_NOT_FOUND', 'Project not found', 404)
    return project
  }

  app.get('/api/v1/projects', async request => {
    parse(emptyQuery, request.query)
    return { projects: projects.listProjects() }
  })

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/worktrees', async request => {
    parse(emptyQuery, request.query)
    const { projectId } = request.params
    requireProject(projectId)
    await worktrees.syncProjectWorktrees(projectId)
    return { worktrees: await worktrees.listWorktrees(projectId) }
  })

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/branches', async request => {
    parse(emptyQuery, request.query)
    const { projectId } = request.params
    requireProject(projectId)
    return projects.listBranches(projectId)
  })

  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/worktrees', async (request, reply) => {
    parse(emptyQuery, request.query)
    const { projectId } = request.params
    const project = requireProject(projectId)
    const input = parse(createWorktreeSchema, request.body)
    const baseRef = parse(safeRef, input.baseRef ?? project.mainBranch)
    // Only create under the project's configured worktree base directory.
    // Reuse the existing service's Git validation, path checks and setup behavior.
    const worktree = await worktrees.createWorktree(projectId, { ...input, baseRef })
    return reply.code(201).send(worktree)
  })

  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/terminals', async (request, reply) => {
    parse(emptyQuery, request.query)
    const { projectId } = request.params
    requireProject(projectId)
    const input = parse(createTerminalSchema, request.body ?? {})
    const worktree = await worktrees.resolveDefaultWorktree(projectId)
    const terminal = terminals.createTerminal(worktree.id, input)
    return reply.code(201).send({ ...terminal, branch: worktree.branch })
  })

  app.post<{ Params: { projectId: string; worktreeId: string } }>('/api/v1/projects/:projectId/worktrees/:worktreeId/terminals', async (request, reply) => {
    parse(emptyQuery, request.query)
    const { projectId, worktreeId } = request.params
    requireProject(projectId)
    const input = parse(createTerminalSchema, request.body ?? {})
    const worktree = worktreeRepo.findById(worktreeId)
    if (!worktree || worktree.projectId !== projectId) {
      throw new AppError('WORKTREE_NOT_FOUND', 'Worktree not found in project', 404)
    }
    if (worktree.isArchived) throw new AppError('WORKTREE_ARCHIVED', 'Cannot create terminal in an archived worktree', 409)
    const terminal = terminals.createTerminal(worktreeId, input)
    return reply.code(201).send(terminal)
  })
}
