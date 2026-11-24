import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import type { Project } from '@worktreehub/shared'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../../db/database.js'
import { createProjectRepository } from '../../db/repositories/project.repository.js'
import { createTerminalRepository } from '../../db/repositories/terminal.repository.js'
import { createWorktreeRepository } from '../../db/repositories/worktree.repository.js'
import { WORKTREE_NOT_MERGED, type AppError } from '../../utils/app-error.js'
import { createWorktreeService } from './worktree.service.js'

type TestContext = {
  rootPath: string
  repoPath: string
  worktreeBasePath: string
}

const tempDirs: string[] = []

async function git(repoPath: string, args: string[]) {
  return execa('git', args, {
    cwd: repoPath,
  })
}

async function writeFile(repoPath: string, name: string, content: string) {
  await fs.writeFile(path.join(repoPath, name), content)
}

async function commitFile(repoPath: string, name: string, content: string, message: string) {
  await writeFile(repoPath, name, content)
  await git(repoPath, ['add', name])
  await git(repoPath, ['commit', '-q', '-m', message])
}

async function createRepo(): Promise<TestContext> {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-worktree-test-'))
  tempDirs.push(rootPath)

  const repoPath = path.join(rootPath, 'repo')
  const worktreeBasePath = path.join(rootPath, 'worktrees')
  await fs.mkdir(repoPath, { recursive: true })
  await fs.mkdir(worktreeBasePath, { recursive: true })

  await git(repoPath, ['init', '-q', '-b', 'main'])
  await git(repoPath, ['config', 'user.name', 'Test User'])
  await git(repoPath, ['config', 'user.email', 'test@example.com'])
  await commitFile(repoPath, 'README.md', 'base\n', 'init')

  return { rootPath, repoPath, worktreeBasePath }
}

async function createService(ctx: TestContext) {
  const db = createDatabase(path.join(ctx.rootPath, 'app.db'))
  const projectRepo = createProjectRepository(db)
  const worktreeRepo = createWorktreeRepository(db)
  const terminalRepo = createTerminalRepository(db)
  const terminalService = {
    createTerminal: () => {
      throw new Error('Unexpected terminal creation')
    },
  } as unknown as Parameters<typeof createWorktreeService>[3]
  const service = createWorktreeService(projectRepo, worktreeRepo, terminalRepo, terminalService)

  const now = new Date().toISOString()
  const project: Project = {
    id: 'proj_test',
    name: 'repo',
    repoPath: ctx.repoPath,
    worktreeBasePath: ctx.worktreeBasePath,
    mainBranch: 'main',
    setupScript: null,
    devServerScript: null,
    createdAt: now,
    updatedAt: now,
  }

  projectRepo.insert(project)

  return { db, service }
}

afterEach(async () => {
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('worktree merge guards', () => {
  it('blocks removing a clean worktree whose branch is not merged', async () => {
    const ctx = await createRepo()
    await git(ctx.repoPath, [
      'worktree',
      'add',
      '-q',
      '-b',
      'unmerged-feature',
      path.join(ctx.worktreeBasePath, 'unmerged-feature'),
      'main',
    ])
    await commitFile(
      path.join(ctx.worktreeBasePath, 'unmerged-feature'),
      'unmerged.txt',
      'unmerged\n',
      'unmerged change'
    )

    const { db, service } = await createService(ctx)
    await service.syncProjectWorktrees('proj_test')
    const worktree = (await service.listWorktrees('proj_test')).find(
      (wt) => wt.branch === 'unmerged-feature'
    )

    expect(worktree?.mergeCheck?.status).toBe('unmerged')
    await expect(service.removeWorktree(worktree!.id)).rejects.toMatchObject({
      code: WORKTREE_NOT_MERGED,
    } satisfies Partial<AppError>)
    await expect(fs.stat(worktree!.path)).resolves.toBeTruthy()

    db.close()
  })

  it('allows removing a clean worktree whose branch has rebase-equivalent patches', async () => {
    const ctx = await createRepo()
    await git(ctx.repoPath, ['switch', '-q', '-c', 'rebased-feature'])
    await commitFile(ctx.repoPath, 'feature.txt', 'feature\n', 'feature change')
    await git(ctx.repoPath, ['switch', '-q', 'main'])
    await commitFile(ctx.repoPath, 'main.txt', 'main advance\n', 'main advance')
    await git(ctx.repoPath, ['cherry-pick', 'rebased-feature'])
    await git(ctx.repoPath, [
      'worktree',
      'add',
      '-q',
      path.join(ctx.worktreeBasePath, 'rebased-feature'),
      'rebased-feature',
    ])

    const { db, service } = await createService(ctx)
    await service.syncProjectWorktrees('proj_test')
    const worktree = (await service.listWorktrees('proj_test')).find(
      (wt) => wt.branch === 'rebased-feature'
    )

    expect(worktree?.mergeCheck?.status).toBe('rebased')
    await service.removeWorktree(worktree!.id)
    await expect(fs.stat(worktree!.path)).rejects.toMatchObject({ code: 'ENOENT' })

    db.close()
  })
})

describe('worktree archiving', () => {
  it('preserves the archived state when worktrees are synced from git', async () => {
    const ctx = await createRepo()
    await git(ctx.repoPath, [
      'worktree',
      'add',
      '-q',
      '-b',
      'stale-feature',
      path.join(ctx.worktreeBasePath, 'stale-feature'),
      'main',
    ])

    const { db, service } = await createService(ctx)
    await service.syncProjectWorktrees('proj_test')
    const worktree = (await service.listWorktrees('proj_test')).find(
      (wt) => wt.branch === 'stale-feature'
    )

    expect(worktree?.isArchived).toBe(false)
    expect(service.updateWorktree(worktree!.id, { isArchived: true }).isArchived).toBe(true)

    await service.syncProjectWorktrees('proj_test')
    const archived = (await service.listWorktrees('proj_test')).find(
      (wt) => wt.id === worktree!.id
    )
    expect(archived?.isArchived).toBe(true)

    db.close()
  })
})

describe('default branch worktree resolution', () => {
  it('reuses the primary worktree on the configured default branch', async () => {
    const ctx = await createRepo()
    const { db, service } = await createService(ctx)
    try {
      const wt = await service.resolveDefaultWorktree('proj_test')
      expect(wt).toMatchObject({branch:'main',path:ctx.repoPath,isMain:true})
      expect((await service.resolveDefaultWorktree('proj_test')).id).toBe(wt.id)
    } finally { db.close() }
  })

  it('reuses a linked default-branch worktree, not a primary checkout on another branch', async () => {
    const ctx = await createRepo()
    await git(ctx.repoPath, ['switch','-c','feature'])
    const target = path.join(ctx.worktreeBasePath,'existing-main')
    await git(ctx.repoPath, ['worktree','add',target,'main'])
    const { db, service } = await createService(ctx)
    try {
      expect(await service.resolveDefaultWorktree('proj_test')).toMatchObject({branch:'main',path:target,isMain:false})
      expect((await git(ctx.repoPath,['branch','--show-current'])).stdout).toBe('feature')
    } finally { db.close() }
  })

  it('attaches the existing default branch once without switching or modifying a dirty primary checkout', async () => {
    const ctx = await createRepo()
    await git(ctx.repoPath, ['switch','-c','feature'])
    await writeFile(ctx.repoPath,'README.md','uncommitted')
    const { db, service } = await createService(ctx)
    try {
      const [a,b] = await Promise.all([service.resolveDefaultWorktree('proj_test'),service.resolveDefaultWorktree('proj_test')])
      expect(a.id).toBe(b.id)
      expect(a.branch).toBe('main')
      expect(a.createdByApp).toBe(true)
      expect(a.path).not.toBe(ctx.repoPath)
      expect((await git(a.path,['branch','--show-current'])).stdout).toBe('main')
      expect((await git(ctx.repoPath,['branch','--show-current'])).stdout).toBe('feature')
      expect(await fs.readFile(path.join(ctx.repoPath,'README.md'),'utf8')).toBe('uncommitted')
      expect((await service.listWorktrees('proj_test')).filter(w=>w.branch==='main')).toHaveLength(1)
    } finally { db.close() }
  })

  it('rejects an archived default checkout and a missing default branch', async () => {
    const ctx = await createRepo()
    const { db, service } = await createService(ctx)
    try {
      const wt = await service.resolveDefaultWorktree('proj_test')
      service.updateWorktree(wt.id,{isArchived:true})
      await expect(service.resolveDefaultWorktree('proj_test')).rejects.toMatchObject({code:'WORKTREE_ARCHIVED',statusCode:409})
      await git(ctx.repoPath,['switch','-c','feature'])
      await git(ctx.repoPath,['branch','-D','main'])
      await expect(service.resolveDefaultWorktree('proj_test')).rejects.toMatchObject({code:'DEFAULT_BRANCH_NOT_FOUND',statusCode:409})
    } finally { db.close() }
  })
})
