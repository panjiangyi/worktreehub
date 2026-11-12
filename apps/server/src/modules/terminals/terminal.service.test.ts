import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../../db/database.js'
import { createProjectRepository } from '../../db/repositories/project.repository.js'
import { createTerminalRepository } from '../../db/repositories/terminal.repository.js'
import { createWorktreeRepository } from '../../db/repositories/worktree.repository.js'
import { createTerminalService } from './terminal.service.js'

const tempDirs: string[] = []

function createMockPtyManager() {
  const exitCallbacks = new Map<string, (exitCode: number | null) => void>()
  const runtimes = new Map<string, { pty: { pid: number } }>()
  const createdInputs: Array<{ terminalId: string; launch?: string; shell?: string; cwd?: string }> = []
  const writes: Array<{ terminalId: string; data: string }> = []

  return {
    has(terminalId: string) {
      return runtimes.has(terminalId)
    },
    get(terminalId: string) {
      return runtimes.get(terminalId)
    },
    create(input: { terminalId: string; launch?: string; shell?: string; cwd?: string }) {
      createdInputs.push(input)
      const runtime = { pty: { pid: 123 } }
      runtimes.set(input.terminalId, runtime)
      return runtime as never
    },
    write(terminalId: string, data: string) {
      writes.push({ terminalId, data })
    },
    resize() {},
    kill(terminalId: string) {
      runtimes.delete(terminalId)
      exitCallbacks.get(terminalId)?.(null)
    },
    attachClient() {},
    detachClient() {},
    detachClientFromAll() {},
    onExit(terminalId: string, callback: (exitCode: number | null) => void) {
      exitCallbacks.set(terminalId, callback)
    },
    emitExit(terminalId: string, exitCode: number | null) {
      runtimes.delete(terminalId)
      exitCallbacks.get(terminalId)?.(exitCode)
    },
    dropRuntime(terminalId: string) {
      runtimes.delete(terminalId)
    },
    createdInputs,
    writes,
  }
}

async function createContext() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-terminal-test-'))
  tempDirs.push(rootPath)

  const db = createDatabase(path.join(rootPath, 'app.db'))
  const projectRepo = createProjectRepository(db)
  const worktreeRepo = createWorktreeRepository(db)
  const terminalRepo = createTerminalRepository(db)
  const ptyManager = createMockPtyManager()
  const terminalService = createTerminalService(
    projectRepo,
    worktreeRepo,
    terminalRepo,
    ptyManager as never,
    {
      host: '127.0.0.1',
      port: 3767,
      databasePath: path.join(rootPath, 'app.db'),
      trustProxy: true,
      defaultShell: '/bin/bash',
      auth: {
        username: 'test-user',
        password: 'test-pass',
        sessionTtlMs: 60_000,
        ipFailureLimit: 5,
        ipWindowMs: 60_000,
        globalFailureLimit: 10,
        globalCooldownMs: 60_000,
        cookieName: 'worktreehub_session',
      },
      terminal: {
        cols: 120,
        rows: 30,
        scrollback: 10000,
      },
      weixin: {
        enabled: false,
        baseUrl: 'http://127.0.0.1:3000',
        apiKey: '',
        accountId: '',
        pollIntervalMs: 2000,
        mediaMaxBytes: 20 * 1024 * 1024,
        mediaRetentionMs: 7 * 24 * 60 * 60 * 1000,
        approvalMode: 'ask',
      },
    }
  )

  return { rootPath, db, projectRepo, worktreeRepo, terminalService, terminalRepo, ptyManager }
}

afterEach(async () => {
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('directory terminals', () => {
  it('reuses the same scope for canonical-equivalent directories', async () => {
    const { rootPath, db, terminalService } = await createContext()
    const actualDir = path.join(rootPath, 'actual')
    const linkDir = path.join(rootPath, 'linked')
    await fs.mkdir(actualDir)
    await fs.symlink(actualDir, linkDir)

    const first = terminalService.openDirectoryTerminal({ cwd: actualDir })
    const second = terminalService.openDirectoryTerminal({ cwd: linkDir })

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(second.terminal.scopeType).toBe('directory')
    expect(second.terminal.scopeId).toBe(first.terminal.scopeId)
    expect(second.terminal.cwd).toBe(first.terminal.cwd)

    db.close()
  })

  it('can create another terminal in the same directory scope and deletes directory sessions on exit', async () => {
    const { rootPath, db, terminalService, terminalRepo, ptyManager } = await createContext()
    const actualDir = path.join(rootPath, 'workspace')
    await fs.mkdir(actualDir)

    const opened = terminalService.openDirectoryTerminal({ cwd: actualDir })
    const second = terminalService.createDirectoryTerminal({ scopeId: opened.terminal.scopeId })

    expect(second.scopeId).toBe(opened.terminal.scopeId)
    expect(second.title).toBe(`${opened.terminal.scopeLabel} #2`)
    expect(terminalRepo.countByScopeId(opened.terminal.scopeId)).toBe(2)

    ptyManager.emitExit(opened.terminal.id, 0)
    ptyManager.emitExit(second.id, 0)

    expect(terminalService.listTerminals()).toEqual([])

    db.close()
  })

  it('trims a renamed title and ignores a blank one', async () => {
    const { rootPath, db, terminalService } = await createContext()
    const actualDir = path.join(rootPath, 'workspace')
    await fs.mkdir(actualDir)

    const opened = terminalService.openDirectoryTerminal({ cwd: actualDir, title: 'shell' })
    const renamed = terminalService.renameTerminal(opened.terminal.id, { title: '  build logs  ' })
    expect(renamed.title).toBe('build logs')

    const unchanged = terminalService.renameTerminal(opened.terminal.id, { title: '   ' })
    expect(unchanged.title).toBe('build logs')

    db.close()
  })
})

async function insertWorktreeFixture(input: Awaited<ReturnType<typeof createContext>>) {
  const repoPath = path.join(input.rootPath, 'repo')
  const worktreePath = path.join(input.rootPath, 'repo-wt')
  await fs.mkdir(repoPath)
  await fs.mkdir(worktreePath)

  const now = new Date().toISOString()
  input.projectRepo.insert({
    id: 'project_1',
    name: 'repo',
    repoPath,
    worktreeBasePath: path.join(input.rootPath, '.worktree'),
    mainBranch: 'main',
    setupScript: null,
    devServerScript: null,
    createdAt: now,
    updatedAt: now,
  })
  input.worktreeRepo.upsert({
    id: 'worktree_1',
    projectId: 'project_1',
    name: 'feature-a',
    displayName: 'Feature A',
    path: worktreePath,
    branch: 'feature-a',
    head: null,
    isMain: false,
    isDirty: false,
    isArchived: false,
    createdByApp: true,
    createdAt: now,
    updatedAt: now,
  })

  return { worktreePath }
}

describe('worktree terminals', () => {
  it('creates worktree terminals as long-lived shell PTY sessions', async () => {
    const context = await createContext()
    const { db, terminalService, ptyManager } = context
    const { worktreePath } = await insertWorktreeFixture(context)

    const created = terminalService.createTerminal('worktree_1', { initialCommand: 'echo hi' })

    expect(created.status).toBe('running')
    expect(created.pid).toBe(123)
    expect(ptyManager.createdInputs).toHaveLength(1)
    expect(ptyManager.createdInputs[0]).toMatchObject({
      terminalId: created.id,
      launch: 'shell',
      shell: '/bin/bash',
      cwd: worktreePath,
    })
    expect(ptyManager.writes).toEqual([{ terminalId: created.id, data: 'echo hi\n' }])

    db.close()
  })

  it('marks a running worktree terminal disconnected when its PTY runtime is missing', async () => {
    const context = await createContext()
    const { db, terminalService, ptyManager, terminalRepo } = context
    await insertWorktreeFixture(context)

    const created = terminalService.createTerminal('worktree_1')
    ptyManager.dropRuntime(created.id)
    terminalRepo.updatePid(created.id, null)

    expect(() => terminalService.ensureTerminalRuntime(created.id)).toThrow('PTY process not found')
    const updated = terminalRepo.findById(created.id)
    expect(updated?.status).toBe('disconnected')
    expect(updated?.pid).toBeNull()

    db.close()
  })
})
