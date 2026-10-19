import type { AgentCapability, AgentDefinition } from '@worktreehub/shared'

export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'progress'; message: string }
  | { type: 'message'; text: string }
  | { type: 'question'; id: string; text: string; options?: string[] }
  | { type: 'approval'; id: string; text: string }
  | { type: 'artifact'; path: string; label?: string }

export type AgentRunInput = {
  cwd: string
  prompt: string
  providerSessionId: string | null
  imagePaths: string[]
  approvalMode: 'ask' | 'auto'
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void | Promise<void>
}

export type AgentRunResult = {
  providerSessionId: string | null
  finalMessage: string
  detail: string
}

export interface CodingAgentDriver {
  readonly definition: AgentDefinition
  readonly capabilities: ReadonlySet<AgentCapability>
  healthCheck(): Promise<{ ok: boolean; detail: string }>
  run(input: AgentRunInput): Promise<AgentRunResult>
  resolveInteraction?(id: string, answer: string): void
}
