export type Project = {
  id: string
  name: string
  repoPath: string
  worktreeBasePath: string
  mainBranch: string
  setupScript: string | null
  devServerScript: string | null
  createdAt: string
  updatedAt: string
}

export type Worktree = {
  id: string
  projectId: string
  name: string
  displayName: string | null
  path: string
  branch: string | null
  head: string | null
  isMain: boolean
  isDirty: boolean
  isArchived: boolean
  mergeCheck?: MergeCheckResult
  createdByApp: boolean
  createdAt: string
  updatedAt: string
}

export type MergeCheckStatus =
  | 'merged'
  | 'rebased'
  | 'unmerged'
  | 'unknown'
  | 'not_applicable'

export type MergeCheckMethod =
  | 'ancestor'
  | 'patch_equivalent'
  | 'none'

export type MergeCheckResult = {
  branch: string | null
  targetRef: string
  sourceCommit: string | null
  status: MergeCheckStatus
  method: MergeCheckMethod
  isMergedToTarget: boolean
  reason?: string
  equivalentCommitCount?: number
  unmergedCommitCount?: number
}

export type CheckMergeInput =
  | {
      branch: string
      worktreeId?: never
      targetRef?: string
    }
  | {
      branch?: never
      worktreeId: string
      targetRef?: string
    }

export type TerminalStatus =
  | 'running'
  | 'exited'
  | 'killed'
  | 'disconnected'

export type TerminalScopeType = 'worktree' | 'directory'

export type TerminalSession = {
  id: string
  projectId: string | null
  worktreeId: string | null
  scopeType: TerminalScopeType
  scopeId: string
  scopeLabel: string
  title: string
  shell: string
  cwd: string
  status: TerminalStatus
  pid: number | null
  cols: number
  rows: number
  exitCode: number | null
  lastActiveAt: string | null
  createdAt: string
  updatedAt: string
}

export type CreateProjectInput = {
  repoPath: string
  worktreeBasePath?: string
  name?: string
  mainBranch?: string
  setupScript?: string
  devServerScript?: string
}

export type UpdateProjectInput = {
  name?: string
  mainBranch?: string
  setupScript?: string | null
  devServerScript?: string | null
}

export type CreateWorktreeInput = {
  branch: string
  baseRef: string
  path?: string
  name?: string
}

export type UpdateWorktreeInput = {
  displayName?: string | null
  isArchived?: boolean
}

export type CreateTerminalInput = {
  shell?: string
  title?: string
  cols?: number
  rows?: number
  initialCommand?: string
}

export type OpenDirectoryTerminalInput = CreateTerminalInput & {
  cwd: string
}

export type CreateDirectoryTerminalInput =
  | (CreateTerminalInput & {
      cwd: string
      scopeId?: never
    })
  | (CreateTerminalInput & {
      cwd?: never
      scopeId: string
    })

export type OpenDirectoryTerminalResult = {
  terminal: TerminalSession
  reused: boolean
}

export type UpdateTerminalInput = {
  title?: string
}

export type LoginInput = {
  username: string
  password: string
}

export type AuthSessionResponse =
  | {
      authenticated: false
    }
  | {
      authenticated: true
      username: string
      expiresAt: string
    }

export type ApiErrorPayload = {
  error: {
    code: string
    message: string
  }
}

