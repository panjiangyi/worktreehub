import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import websocket from '@fastify/websocket'
import path from 'node:path'
import fs from 'node:fs'
import type { AppConfig } from './config.js'
import { createDatabase } from './db/database.js'
import { createProjectRepository } from './db/repositories/project.repository.js'
import { createWorktreeRepository } from './db/repositories/worktree.repository.js'
import { createTerminalRepository } from './db/repositories/terminal.repository.js'
import { createWeixinRepository } from './db/repositories/weixin.repository.js'
import { createProjectService } from './modules/projects/project.service.js'
import { createWorktreeService } from './modules/worktrees/worktree.service.js'
import { createTerminalService } from './modules/terminals/terminal.service.js'
import { createAuthService } from './modules/auth/auth.service.js'
import { createPtyManager } from './modules/pty/pty.manager.js'
import { createAgentRegistry } from './modules/agents/agent.registry.js'
import { createWeixinService } from './modules/weixin/weixin.service.js'
import { createFsService } from './modules/fs/fs.service.js'
import { registerAuthRoutes } from './routes/auth.routes.js'
import { registerHealthRoutes } from './routes/health.routes.js'
import { registerProjectRoutes } from './routes/projects.routes.js'
import { registerWorktreeRoutes } from './routes/worktrees.routes.js'
import { registerTerminalRoutes } from './routes/terminals.routes.js'
import { registerFsRoutes } from './routes/fs.routes.js'
import { registerDebugRoutes } from './routes/debug.routes.js'
import { registerWeixinRoutes } from './routes/weixin.routes.js'
import { registerTerminalWebSocket } from './websocket/terminal.ws.js'
import { AppError } from './utils/app-error.js'
import { normalizeAbsoluteRequestUrl } from './utils/request-url.js'

export async function buildApp(config: AppConfig) {
  const app = Fastify({
    logger: true,
    trustProxy: config.trustProxy,
  })

  // Initialize database
  const db = createDatabase(config.databasePath)

  // Initialize repositories
  const projectRepo = createProjectRepository(db)
  const worktreeRepo = createWorktreeRepository(db)
  const terminalRepo = createTerminalRepository(db)
  const weixinRepo = createWeixinRepository(db)

  // Initialize PTY manager
  const ptyManager = createPtyManager()

  // Initialize services
  const terminalService = createTerminalService(
    projectRepo,
    worktreeRepo,
    terminalRepo,
    ptyManager,
    config
  )
  const worktreeService = createWorktreeService(projectRepo, worktreeRepo, terminalRepo, terminalService)
  const projectService = createProjectService(
    projectRepo,
    worktreeRepo,
    terminalRepo,
    worktreeService.syncProjectWorktrees.bind(worktreeService)
  )
  const agentRegistry = createAgentRegistry(weixinRepo)
  const weixinService = createWeixinService({
    config,
    repo: weixinRepo,
    projectRepo,
    worktreeRepo,
    projectService,
    worktreeService,
    agents: agentRegistry,
  })
  const fsService = createFsService()
  const authService = createAuthService(config)

  // Directory terminals are ephemeral; worktree terminals are in-process PTY sessions.
  terminalRepo.deleteDirectorySessions()

  // Register plugins
  await app.register(cookie)
  await app.register(websocket)

  app.addHook('onRequest', async (request) => {
    request.raw.url = normalizeAbsoluteRequestUrl(request.raw.url ?? '')

    const routePath = request.raw.url ?? ''
    if (routePath === '/health' || routePath.startsWith('/api/auth/') || routePath.startsWith('/api/debug/')) {
      return
    }

    if (routePath === '/ws/terminal') {
      authService.requireSession(request)
      authService.enforceSameOrigin(request)
      return
    }

    if (!routePath.startsWith('/api/')) {
      return
    }

    authService.requireSession(request)
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS') {
      authService.enforceSameOrigin(request)
    }
  })

  // Error handler
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
        },
      })
      return
    }

    const err = error as { validation?: unknown; message?: string }
    if (err.validation) {
      reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.message ?? 'Validation error',
        },
      })
      return
    }

    request.log.error(error)

    reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    })
  })

  // Register routes
  await registerHealthRoutes(app)
  await registerAuthRoutes(app, authService)
  await registerProjectRoutes(app, projectService)
  await registerWorktreeRoutes(app, worktreeService)
  await registerTerminalRoutes(app, terminalService)
  await registerFsRoutes(app, fsService)
  await registerDebugRoutes(app)
  await registerWeixinRoutes(app, weixinService)
  registerTerminalWebSocket(app, terminalService, ptyManager, authService)

  weixinService.start()
  app.addHook('onClose', async () => {
    await weixinService.stop()
    db.close()
  })

  // Serve static files in production
  const webDistPath = path.resolve(import.meta.dirname, '../../web/dist')
  if (fs.existsSync(webDistPath)) {
    const fastifyStatic = await import('@fastify/static')
    await app.register(fastifyStatic.default, {
      root: webDistPath,
      prefix: '/',
    })

    // SPA fallback
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api') || request.url.startsWith('/ws')) {
        reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Route not found',
          },
        })
        return
      }
      return reply.sendFile('index.html')
    })
  }

  return app
}
