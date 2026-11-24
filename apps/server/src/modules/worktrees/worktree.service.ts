import path from 'node:path'
import { nanoid } from 'nanoid'
import type {
  Worktree,
  CreateWorktreeInput,
  UpdateWorktreeInput,
  CheckMergeInput,
  MergeCheckResult,
} from '@worktreehub/shared'
import * as git from '../git/git.service.js'
import { assertPathInside, normalizePath } from '../security/path-safety.js'
import {
  AppError,
  WORKTREE_NOT_FOUND,
  WORKTREE_PATH_EXISTS,
  WORKTREE_DIRTY,
  WORKTREE_HAS_RUNNING_TERMINALS,
  CANNOT_REMOVE_MAIN_WORKTREE,
  WORKTREE_NOT_MERGED,
  BASE_REF_NOT_FOUND,
  BRANCH_EXISTS,
  PROJECT_NOT_FOUND,
} from '../../utils/app-error.js'
import type { createProjectRepository } from '../../db/repositories/project.repository.js'
import type { createWorktreeRepository } from '../../db/repositories/worktree.repository.js'
import type { createTerminalRepository } from '../../db/repositories/terminal.repository.js'
import type { createTerminalService } from '../terminals/terminal.service.js'

type ProjectRepo = ReturnType<typeof createProjectRepository>
type WorktreeRepo = ReturnType<typeof createWorktreeRepository>
type TerminalRepo = ReturnType<typeof createTerminalRepository>
type TerminalSvc = ReturnType<typeof createTerminalService>

function getWorktreeName(info: { path: string; branch: string | null }, project: { repoPath: string }): string {
  if (info.branch) {
    return info.branch.replace(/[\/\\]/g, '-')
  }
  const dirname = path.basename(info.path)
  if (dirname) {
    return dirname
  }
  if (normalizePath(info.path) === normalizePath(project.repoPath)) {
    return path.basename(project.repoPath) || 'root'
  }
  return 'unknown'
}

function notApplicableMergeCheck(
  targetRef: string,
  branch: string | null,
  reason: string
): MergeCheckResult {
  return {
    branch,
    targetRef,
    sourceCommit: null,
    status: 'not_applicable',
    method: 'none',
    isMergedToTarget: false,
    reason,
  }
}

function unknownMergeCheck(
  targetRef: string,
  branch: string | null,
  reason: string
): MergeCheckResult {
  return {
    branch,
    targetRef,
    sourceCommit: null,
    status: 'unknown',
    method: 'none',
    isMergedToTarget: false,
    reason,
  }
}

export type WorktreeService = ReturnType<typeof createWorktreeService>

export function createWorktreeService(
  projectRepo: ProjectRepo,
  worktreeRepo: WorktreeRepo,
  terminalRepo: TerminalRepo,
  terminalService: TerminalSvc
) {
  async function getWorktreeMergeCheck(
    project: { repoPath: string; mainBranch: string },
    worktree: Pick<Worktree, 'branch' | 'isMain'>
  ): Promise<MergeCheckResult> {
    if (worktree.isMain) {
      return notApplicableMergeCheck(
        project.mainBranch,
        worktree.branch,
        'Main worktree is not removable.'
      )
    }

    if (!worktree.branch) {
      return unknownMergeCheck(
        project.mainBranch,
        null,
        'Worktree is detached and has no local branch.'
      )
    }

    try {
      return await git.checkBranchMergedToTarget(
        project.repoPath,
        worktree.branch,
        project.mainBranch
      )
    } catch {
      return unknownMergeCheck(
        project.mainBranch,
        worktree.branch,
        'Could not determine merge status.'
      )
    }
  }

  async function withMergeChecks(
    projectId: string,
    worktrees: Worktree[]
  ): Promise<Worktree[]> {
    const project = projectRepo.findById(projectId)
    if (!project) return worktrees

    return Promise.all(
      worktrees.map(async (worktree) => ({
        ...worktree,
        mergeCheck: await getWorktreeMergeCheck(project, worktree),
      }))
    )
  }

  // Serialize default-branch resolution for concurrent task launches in a project.
  const defaultWorktreePending = new Map<string, Promise<Worktree>>()

  return {
    async resolveDefaultWorktree(projectId: string): Promise<Worktree> {
      const pending = defaultWorktreePending.get(projectId)
      if (pending) return pending
      const resolve = async (): Promise<Worktree> => {
        const project = projectRepo.findById(projectId)
        if (!project) throw new AppError(PROJECT_NOT_FOUND, 'Project not found', 404)
        const branch = project.mainBranch
        if (!branch || branch.startsWith('-') || !(await git.branchExists(project.repoPath, branch))) {
          throw new AppError('DEFAULT_BRANCH_NOT_FOUND', 'Configured default local branch does not exist', 409)
        }

        const findCheckedOut = () => worktreeRepo.findByProjectId(projectId)
          .filter(wt => wt.branch === branch)
          .sort((a, b) => Number(b.isMain) - Number(a.isMain))
        const verify = async (wt: Worktree): Promise<Worktree> => {
          if (wt.isArchived) throw new AppError('WORKTREE_ARCHIVED', 'Default branch worktree is archived', 409)
          if (await git.getCheckedOutBranch(wt.path) !== branch) {
            throw new AppError('DEFAULT_WORKTREE_UNAVAILABLE', 'Default branch checkout is unavailable or changed', 409)
          }
          return wt
        }

        await this.syncProjectWorktrees(projectId)
        const checkedOut = findCheckedOut()
        if (checkedOut.length) {
          const usable = checkedOut.find(wt => !wt.isArchived)
          return verify(usable ?? checkedOut[0])
        }

        // Never change the checkout of an existing directory. If the default
        // branch is not checked out, attach that same branch in a fresh path.
        const target = path.resolve(project.worktreeBasePath, 'default-' + nanoid())
        assertPathInside(project.worktreeBasePath, target)
        try {
          await git.attachBranchWorktree(project.repoPath, target, branch)
        } catch (error) {
          // Another process may have attached the branch after the first sync.
          await this.syncProjectWorktrees(projectId)
          const existing = findCheckedOut().find(wt => !wt.isArchived)
          if (existing) return verify(existing)
          throw error
        }
        await this.syncProjectWorktrees(projectId)
        const attached = worktreeRepo.findByPath(target)
        if (!attached || attached.projectId !== projectId || attached.branch !== branch) {
          throw new AppError('DEFAULT_WORKTREE_UNAVAILABLE', 'Could not resolve default branch checkout', 409)
        }
        const verified = await verify(attached)
        const result = { ...verified, createdByApp: true }
        worktreeRepo.upsert(result)
        return result
      }
      const operation = resolve()
      defaultWorktreePending.set(projectId, operation)
      try {
        return await operation
      } finally {
        if (defaultWorktreePending.get(projectId) === operation) defaultWorktreePending.delete(projectId)
      }
    },

    async syncProjectWorktrees(projectId: string): Promise<void> {
      const project = projectRepo.findById(projectId)
      if (!project) return

      const gitWorktrees = await git.listWorktrees(project.repoPath)
      const keptIds: string[] = []

      for (const info of gitWorktrees) {
        const existing = worktreeRepo.findByPath(info.path)
        const isMain = normalizePath(info.path) === normalizePath(project.repoPath)

        let isDirty = false
        try {
          isDirty = await git.isWorktreeDirty(info.path)
        } catch {
          // Path might not exist
        }

        const now = new Date().toISOString()
        const worktree: Worktree = {
          id: existing?.id ?? `wt_${nanoid()}`,
          projectId,
          name: getWorktreeName(info, project),
          displayName: existing?.displayName ?? null,
          path: info.path,
          branch: info.branch,
          head: info.head,
          isMain,
          isDirty,
          isArchived: existing?.isArchived ?? false,
          createdByApp: existing?.createdByApp ?? false,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        }

        worktreeRepo.upsert(worktree)
        keptIds.push(worktree.id)
      }

      // Clean up worktrees that no longer exist in git.
      // Don't gate on runningCount — if the git path is gone the terminals
      // can't actually be running; orphaned "running" DB records would
      // block cleanup forever. DB cascade handles terminal record removal.
      const existingWorktrees = worktreeRepo.findByProjectId(projectId)
      for (const wt of existingWorktrees) {
        if (!keptIds.includes(wt.id)) {
          worktreeRepo.delete(wt.id)
        }
      }
    },

    async createWorktree(projectId: string, input: CreateWorktreeInput): Promise<Worktree> {
      const project = projectRepo.findById(projectId)
      if (!project) {
        throw new AppError(PROJECT_NOT_FOUND, 'Project not found')
      }

      const worktreePath = input.path || `${project.worktreeBasePath}/${input.branch}`

      // Validate path is inside worktreeBasePath
      assertPathInside(project.worktreeBasePath, worktreePath)

      // Check path doesn't exist
      const existingAtPath = worktreeRepo.findByPath(worktreePath)
      if (existingAtPath) {
        throw new AppError(WORKTREE_PATH_EXISTS, 'Path already exists')
      }

      // Check base ref exists
      const baseRefExists = await git.refExists(project.repoPath, input.baseRef)
      if (!baseRefExists) {
        throw new AppError(BASE_REF_NOT_FOUND, 'Base ref not found')
      }

      // Check branch doesn't exist
      const branchAlreadyExists = await git.branchExists(project.repoPath, input.branch)
      if (branchAlreadyExists) {
        throw new AppError(BRANCH_EXISTS, 'Branch already exists')
      }

      // Create worktree in git
      await git.createWorktree({
        repoPath: project.repoPath,
        branch: input.branch,
        path: worktreePath,
        baseRef: input.baseRef,
      })

      // Sync to get the new worktree
      await this.syncProjectWorktrees(projectId)

      const newWorktree = worktreeRepo.findByPath(worktreePath)
      if (!newWorktree) {
        throw new AppError('WORKTREE_CREATE_FAILED', 'Failed to create worktree')
      }

      const displayName = input.name || null
      worktreeRepo.upsert({ ...newWorktree, createdByApp: true, displayName })

      const result = { ...newWorktree, createdByApp: true, displayName }

      if (project.setupScript) {
        try {
          terminalService.createTerminal(result.id, {
            title: 'setup',
            initialCommand: project.setupScript,
          })
        } catch {
          // Non-fatal: setup script execution failed
        }
      }

      return result
    },

    async removeWorktree(worktreeId: string): Promise<void> {
      const wt = worktreeRepo.findById(worktreeId)
      if (!wt) {
        throw new AppError(WORKTREE_NOT_FOUND, 'Worktree not found')
      }

      if (wt.isMain) {
        throw new AppError(CANNOT_REMOVE_MAIN_WORKTREE, 'Cannot remove main worktree')
      }

      const project = projectRepo.findById(wt.projectId)
      if (!project) {
        throw new AppError(PROJECT_NOT_FOUND, 'Project not found')
      }

      // Check git existence first — stale worktrees (path gone from git) should
      // always be deletable regardless of DB terminal state or merge status.
      // DB cascade handles terminal record cleanup.
      const gitWorktrees = await git.listWorktrees(project.repoPath)
      const existsInGit = gitWorktrees.some(
        (info) => normalizePath(info.path) === normalizePath(wt.path)
      )
      if (!existsInGit) {
        worktreeRepo.delete(worktreeId)
        return
      }

      // Worktree exists in git — apply the standard guards
      const runningCount = terminalRepo.countRunningByWorktreeId(worktreeId)
      if (runningCount > 0) {
        throw new AppError(
          WORKTREE_HAS_RUNNING_TERMINALS,
          'Close terminals before removing worktree'
        )
      }

      if (wt.isDirty) {
        throw new AppError(WORKTREE_DIRTY, 'Cannot remove dirty worktree')
      }

      const mergeCheck = await getWorktreeMergeCheck(project, wt)
      if (!mergeCheck.isMergedToTarget) {
        const reason = mergeCheck.reason
          ? ` ${mergeCheck.reason}`
          : ''
        throw new AppError(
          WORKTREE_NOT_MERGED,
          `Cannot remove worktree because branch is not merged into ${mergeCheck.targetRef}.${reason}`
        )
      }

      await git.removeWorktree({
        repoPath: project.repoPath,
        path: wt.path,
      })

      worktreeRepo.delete(worktreeId)
      await this.syncProjectWorktrees(wt.projectId)
    },

    updateWorktree(worktreeId: string, input: UpdateWorktreeInput): Worktree {
      const wt = worktreeRepo.findById(worktreeId)
      if (!wt) {
        throw new AppError(WORKTREE_NOT_FOUND, 'Worktree not found')
      }

      const displayName =
        input.displayName === undefined
          ? wt.displayName
          : input.displayName?.trim() || null
      const isArchived = input.isArchived ?? wt.isArchived
      const updatedAt = new Date().toISOString()
      const updated = { ...wt, displayName, isArchived, updatedAt }
      worktreeRepo.upsert(updated)
      return updated
    },

    async refreshWorktreeDirty(worktreeId: string): Promise<Worktree> {
      const wt = worktreeRepo.findById(worktreeId)
      if (!wt) {
        throw new AppError(WORKTREE_NOT_FOUND, 'Worktree not found')
      }

      let isDirty = false
      try {
        isDirty = await git.isWorktreeDirty(wt.path)
      } catch {
        // Path might not exist
      }

      const now = new Date().toISOString()
      worktreeRepo.upsert({ ...wt, isDirty, updatedAt: now })

      return { ...wt, isDirty, updatedAt: now }
    },

    async checkProjectMerge(
      projectId: string,
      input: CheckMergeInput
    ): Promise<MergeCheckResult> {
      const project = projectRepo.findById(projectId)
      if (!project) {
        throw new AppError(PROJECT_NOT_FOUND, 'Project not found')
      }

      const targetRef = input.targetRef?.trim() || project.mainBranch

      if (input.worktreeId) {
        const wt = worktreeRepo.findById(input.worktreeId)
        if (!wt) {
          throw new AppError(WORKTREE_NOT_FOUND, 'Worktree not found')
        }
        if (wt.projectId !== projectId) {
          throw new AppError(WORKTREE_NOT_FOUND, 'Worktree not found in project')
        }

        const projectForCheck = { repoPath: project.repoPath, mainBranch: targetRef }
        return getWorktreeMergeCheck(projectForCheck, wt)
      }

      if (!input.branch) {
        throw new AppError('INVALID_MERGE_CHECK_INPUT', 'Branch is required')
      }

      return git.checkBranchMergedToTarget(project.repoPath, input.branch, targetRef)
    },

    async listWorktrees(projectId: string): Promise<Worktree[]> {
      return withMergeChecks(projectId, worktreeRepo.findByProjectId(projectId))
    },
  }
}
