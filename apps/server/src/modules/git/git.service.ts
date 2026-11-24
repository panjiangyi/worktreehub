import { execa } from 'execa'
import type { MergeCheckResult } from '@worktreehub/shared'
import { AppError } from '../../utils/app-error.js'
import { parseWorktreePorcelain } from './git.parser.js'
import type { GitWorktreeInfo } from './git.types.js'

const ALLOWED_COMMANDS = [
  'worktree',
  'status',
  'rev-parse',
  'show-ref',
  'branch',
  'for-each-ref',
  'symbolic-ref',
  'merge-base',
  'cherry',
]

export type GitCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runGitResult(args: string[], cwd: string): Promise<GitCommandResult> {
  if (!ALLOWED_COMMANDS.includes(args[0])) {
    throw new AppError('INVALID_GIT_COMMAND', `Git command not allowed: ${args[0]}`)
  }

  const result = await execa('git', args, {
    cwd,
    reject: false,
  })

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
  }
}

export async function runGit(args: string[], cwd: string): Promise<string> {
  const result = await runGitResult(args, cwd)

  if (result.exitCode !== 0) {
    throw new AppError(
      'GIT_COMMAND_FAILED',
      result.stderr || result.stdout || 'Git command failed'
    )
  }

  return result.stdout
}

export async function isGitRepository(path: string): Promise<boolean> {
  try {
    const stdout = await runGit(['rev-parse', '--is-inside-work-tree'], path)
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

export async function getRepoRoot(path: string): Promise<string> {
  const stdout = await runGit(['rev-parse', '--show-toplevel'], path)
  return stdout.trim()
}

export async function listWorktrees(repoPath: string): Promise<GitWorktreeInfo[]> {
  const stdout = await runGit(['worktree', 'list', '--porcelain'], repoPath)
  return parseWorktreePorcelain(stdout)
}

export async function isWorktreeDirty(worktreePath: string): Promise<boolean> {
  const stdout = await runGit(['status', '--porcelain'], worktreePath)
  return stdout.trim().length > 0
}

export async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await runGit(['rev-parse', '--verify', ref], repoPath)
    return true
  } catch {
    return false
  }
}

export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await runGit(['show-ref', '--verify', `refs/heads/${branch}`], repoPath)
    return true
  } catch {
    return false
  }
}

export async function createWorktree(input: {
  repoPath: string
  branch: string
  path: string
  baseRef: string
}): Promise<void> {
  await runGit(
    ['worktree', 'add', '-b', input.branch, input.path, input.baseRef],
    input.repoPath
  )
}

// Attach an existing local branch without forcing or creating a new branch.
export async function attachBranchWorktree(repoPath: string, worktreePath: string, branch: string): Promise<void> {
  await runGit(['worktree', 'add', '--', worktreePath, branch], repoPath)
}

export async function getCheckedOutBranch(worktreePath: string): Promise<string | null> {
  const result = await runGitResult(['symbolic-ref', '--quiet', 'HEAD'], worktreePath)
  return result.exitCode === 0 && result.stdout.startsWith('refs/heads/')
    ? result.stdout.trim().slice('refs/heads/'.length)
    : null
}

export async function removeWorktree(input: {
  repoPath: string
  path: string
}): Promise<void> {
  await runGit(['worktree', 'remove', input.path], input.repoPath)
}

export async function listBranches(repoPath: string): Promise<{ local: string[]; remote: string[] }> {
  const stdout = await runGit(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    repoPath
  )

  const local: string[] = []
  const remote: string[] = []

  for (const line of stdout.split('\n')) {
    const ref = line.trim()
    if (!ref) continue
    if (ref.startsWith('remotes/')) {
      remote.push(ref.replace('remotes/', ''))
    } else {
      local.push(ref)
    }
  }

  return { local, remote }
}

export async function detectDefaultBranch(repoPath: string): Promise<string> {
  try {
    const stdout = await runGit(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath)
    return stdout.trim().replace('refs/remotes/origin/', '')
  } catch {
    if (await branchExists(repoPath, 'main')) return 'main'
    if (await branchExists(repoPath, 'master')) return 'master'

    try {
      const stdout = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath)
      return stdout.trim()
    } catch {
      return 'main'
    }
  }
}

function unknownMergeCheck(input: {
  branch: string | null
  targetRef: string
  sourceCommit?: string | null
  reason: string
}): MergeCheckResult {
  return {
    branch: input.branch,
    targetRef: input.targetRef,
    sourceCommit: input.sourceCommit ?? null,
    status: 'unknown',
    method: 'none',
    isMergedToTarget: false,
    reason: input.reason,
  }
}

export async function checkBranchMergedToTarget(
  repoPath: string,
  branch: string,
  targetRef: string
): Promise<MergeCheckResult> {
  const branchRef = `refs/heads/${branch}`
  const branchExistsResult = await runGitResult(
    ['show-ref', '--verify', branchRef],
    repoPath
  )
  if (branchExistsResult.exitCode !== 0) {
    return unknownMergeCheck({
      branch,
      targetRef,
      reason: 'Local branch does not exist.',
    })
  }

  const targetCommitResult = await runGitResult(
    ['rev-parse', '--verify', `${targetRef}^{commit}`],
    repoPath
  )
  if (targetCommitResult.exitCode !== 0) {
    return unknownMergeCheck({
      branch,
      targetRef,
      reason: 'Target ref does not resolve to a commit.',
    })
  }

  const sourceCommitResult = await runGitResult(
    ['rev-parse', '--verify', `${branchRef}^{commit}`],
    repoPath
  )
  if (sourceCommitResult.exitCode !== 0) {
    return unknownMergeCheck({
      branch,
      targetRef,
      reason: 'Branch does not resolve to a commit.',
    })
  }

  const sourceCommit = sourceCommitResult.stdout.trim()
  const ancestorResult = await runGitResult(
    ['merge-base', '--is-ancestor', sourceCommit, targetRef],
    repoPath
  )
  if (ancestorResult.exitCode === 0) {
    return {
      branch,
      targetRef,
      sourceCommit,
      status: 'merged',
      method: 'ancestor',
      isMergedToTarget: true,
      reason: `Branch commit is an ancestor of ${targetRef}.`,
      equivalentCommitCount: 0,
      unmergedCommitCount: 0,
    }
  }

  const cherryResult = await runGitResult(['cherry', targetRef, branchRef], repoPath)
  if (cherryResult.exitCode !== 0) {
    return unknownMergeCheck({
      branch,
      targetRef,
      sourceCommit,
      reason: cherryResult.stderr || cherryResult.stdout || 'Could not compare branch patches.',
    })
  }

  const cherryLines = cherryResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const equivalentCommitCount = cherryLines.filter((line) => line.startsWith('-')).length
  const unmergedCommitCount = cherryLines.filter((line) => line.startsWith('+')).length

  if (cherryLines.length > 0 && unmergedCommitCount === 0 && equivalentCommitCount > 0) {
    return {
      branch,
      targetRef,
      sourceCommit,
      status: 'rebased',
      method: 'patch_equivalent',
      isMergedToTarget: true,
      reason: `Branch patches are already present in ${targetRef}.`,
      equivalentCommitCount,
      unmergedCommitCount,
    }
  }

  if (unmergedCommitCount > 0) {
    return {
      branch,
      targetRef,
      sourceCommit,
      status: 'unmerged',
      method: 'none',
      isMergedToTarget: false,
      reason: `Branch has commits not present in ${targetRef}.`,
      equivalentCommitCount,
      unmergedCommitCount,
    }
  }

  return unknownMergeCheck({
    branch,
    targetRef,
    sourceCommit,
    reason: 'Could not determine whether branch changes are present in target.',
  })
}
