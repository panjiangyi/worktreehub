import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDatabase } from '../database.js'
import { createWeixinRepository } from './weixin.repository.js'

const tempDirs: string[] = []
afterEach(async () => Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))))

function seedCodingContext(db: ReturnType<typeof createDatabase>, repo: ReturnType<typeof createWeixinRepository>, suffix = '') {
  const now = new Date().toISOString()
  const projectId = `project${suffix}`
  const worktreeId = `worktree${suffix}`
  const sessionId = `session${suffix}`
  if (!repo.getBinding()) {
    repo.bind({ id: 'owner', accountId: 'account', userId: 'user', displayName: null, activeProjectId: null,
      activeWorktreeId: null, activeAgentId: 'codex', createdAt: now, updatedAt: now })
  }
  db.prepare(`INSERT INTO projects(id,name,repo_path,worktree_base_path,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(projectId, projectId, `/repo/${projectId}`, `/worktrees/${projectId}`, now, now)
  db.prepare(`INSERT INTO worktrees(id,project_id,name,path,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
    .run(worktreeId, projectId, worktreeId, `/repo/${projectId}/${worktreeId}`, now, now)
  repo.insertSession({ id: sessionId, bindingId: 'owner', worktreeId, agentId: 'codex', providerSessionId: null,
    status: 'ready', createdAt: now, updatedAt: now })
  return { now, worktreeId, sessionId }
}

describe('weixin repository', () => {
  it('persists the owner, cursor, idempotency and built-in drivers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    const now = new Date().toISOString()
    repo.bind({ id: 'owner', accountId: 'account', userId: 'user', displayName: null, activeProjectId: null,
      activeWorktreeId: null, activeAgentId: 'codex', createdAt: now, updatedAt: now })
    repo.setCursor('account', 42)

    expect(repo.getBinding()?.userId).toBe('user')
    expect(repo.getCursor('account')).toBe(42)
    expect(repo.markProcessed('account', 43)).toBe(true)
    expect(repo.markProcessed('account', 43)).toBe(false)
    expect(repo.listAgents().map((agent) => agent.id)).toEqual(expect.arrayContaining(['codex', 'claude', 'opencode']))
    db.close()
  })

  it('expires pending menu state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    const now = new Date().toISOString()
    repo.bind({ id: 'owner', accountId: 'account', userId: 'user', displayName: null, activeProjectId: null,
      activeWorktreeId: null, activeAgentId: 'codex', createdAt: now, updatedAt: now })
    repo.setPending('owner', 'menu', {}, -1)
    expect(repo.getPending('owner')).toBeNull()
    db.close()
  })

  it('claims outbox messages before delivery to avoid duplicate concurrent sends', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)

    repo.enqueueOutbox({ id: 'out_1', accountId: 'account', userId: 'user', kind: 'text', payload: { text: 'hello' } })

    expect(repo.claimPendingOutbox()).toHaveLength(1)
    expect(repo.claimPendingOutbox()).toHaveLength(0)

    repo.markOutboxFailed('out_1', 1, 'temporary error')
    expect(repo.claimPendingOutbox()).toHaveLength(0)
    db.close()
  })

  it('recovers in-flight outbox messages on repository startup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)

    repo.enqueueOutbox({ id: 'out_1', accountId: 'account', userId: 'user', kind: 'text', payload: { text: 'hello' } })
    expect(repo.claimPendingOutbox()).toHaveLength(1)

    const recovered = createWeixinRepository(db)
    expect(recovered.claimPendingOutbox()).toHaveLength(1)
    db.close()
  })

  it('dead-letters an outbox message after repeated delivery failures', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    repo.enqueueOutbox({ id: 'out_failed', accountId: 'account', userId: 'user', kind: 'text', payload: { text: 'hello' } })
    repo.markOutboxFailed('out_failed', 10, 'permanent error')

    expect(repo.claimPendingOutbox()).toEqual([])
    expect(db.prepare('SELECT status,attempts FROM weixin_outbox WHERE id=?').get('out_failed'))
      .toEqual({ status: 'failed', attempts: 10 })
    db.close()
  })

  it('persists image attachments and atomically claims queued tasks', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    const { now, worktreeId, sessionId } = seedCodingContext(db, repo)
    const task = { id: 'task_123456', sessionId, sourceMessageSeq: 7, prompt: 'fix it', imagePaths: ['/tmp/input.png'],
      status: 'queued' as const, summary: null, detail: null, error: null, startedAt: null, completedAt: null,
      createdAt: now, updatedAt: now }

    expect(repo.insertTask(task)).toBe(true)
    expect(repo.insertTask({ ...task, id: 'task_duplicate' })).toBe(false)
    expect(repo.listQueuedWorktreeIds()).toEqual([worktreeId])

    const claimed = repo.claimNextQueuedTask(worktreeId)
    expect(claimed).toMatchObject({ id: task.id, status: 'running', imagePaths: ['/tmp/input.png'], userId: 'user' })
    expect(repo.claimNextQueuedTask(worktreeId)).toBeNull()
    db.close()
  })

  it('fails interrupted tasks without replaying them and closes their pending interaction', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    const { now, worktreeId, sessionId } = seedCodingContext(db, repo)
    repo.insertTask({ id: 'task_abcdef', sessionId, sourceMessageSeq: 8, prompt: 'deploy', imagePaths: [], status: 'waiting',
      summary: null, detail: null, error: null, startedAt: now, completedAt: null, createdAt: now, updatedAt: now })
    repo.setTaskInteraction({ id: 'interaction_1', bindingId: 'owner', taskId: 'task_abcdef', worktreeId,
      kind: 'approval', agentInteractionId: 'approval_1', payload: { text: 'deploy?' } })

    expect(repo.recoverInterruptedTasks()).toHaveLength(1)
    expect(repo.getTask('task_abcdef')).toMatchObject({ status: 'failed' })
    expect(repo.getTask('task_abcdef')?.error).toContain('restarted')
    expect(repo.listPendingTaskInteractions('owner')).toEqual([])
    db.close()
  })

  it('keeps pending questions isolated per task and records their resolution', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    const first = seedCodingContext(db, repo, '_one')
    const second = seedCodingContext(db, repo, '_two')
    for (const [id, context] of [['task_one111', first], ['task_two222', second]] as const) {
      repo.insertTask({ id, sessionId: context.sessionId, sourceMessageSeq: null, prompt: id, imagePaths: [], status: 'waiting',
        summary: null, detail: null, error: null, startedAt: context.now, completedAt: null,
        createdAt: context.now, updatedAt: context.now })
      repo.setTaskInteraction({ id: `interaction_${id}`, bindingId: 'owner', taskId: id, worktreeId: context.worktreeId,
        kind: 'question', agentInteractionId: `question_${id}`, payload: { text: id } })
    }

    const pending = repo.listPendingTaskInteractions('owner')
    expect(pending.map((item) => item.taskId)).toEqual(expect.arrayContaining(['task_one111', 'task_two222']))
    expect(repo.resolveTaskInteraction('interaction_task_one111', 'yes')).toBe(true)
    expect(repo.listPendingTaskInteractions('owner').map((item) => item.taskId)).toEqual(['task_two222'])
    db.close()
  })

  it('returns expired task interactions for the worker to cancel', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-weixin-'))
    tempDirs.push(root)
    const db = createDatabase(path.join(root, 'app.db'))
    const repo = createWeixinRepository(db)
    const context = seedCodingContext(db, repo)
    repo.insertTask({ id: 'task_timeout', sessionId: context.sessionId, sourceMessageSeq: null, prompt: 'wait', imagePaths: [],
      status: 'waiting', summary: null, detail: null, error: null, startedAt: context.now, completedAt: null,
      createdAt: context.now, updatedAt: context.now })
    repo.setTaskInteraction({ id: 'interaction_timeout', bindingId: 'owner', taskId: 'task_timeout',
      worktreeId: context.worktreeId, kind: 'question', agentInteractionId: 'question_timeout', payload: { text: '?' } }, -1)

    expect(repo.listPendingTaskInteractions('owner')).toEqual([])
    expect(repo.expireTaskInteractions()).toMatchObject([{ id: 'interaction_timeout', status: 'expired' }])
    expect(repo.expireTaskInteractions()).toEqual([])
    db.close()
  })
})
