import type { Terminal } from '@xterm/headless'
import type { IPty } from 'node-pty'
import type WebSocket from 'ws'
import type { OutputReplayBuffer } from './output-replay-buffer.js'

export type PtyRuntimeSession = {
  terminalId: string
  pty: IPty
  outputBuffer: OutputReplayBuffer
  screen: Terminal
  clients: Set<WebSocket>
  createdAt: string
}

export type CreatePtyInput = {
  terminalId: string
  cwd: string
  cols: number
  rows: number
  env: Record<string, string>
} & (
  | {
      launch: 'shell'
      shell: string
    }
  | {
      launch: 'command'
      file: string
      args: string[]
    }
)
