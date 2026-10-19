import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { config as loadDotEnv, parse as parseDotEnv } from 'dotenv'

const repoRoot = path.resolve(import.meta.dirname, '../../../')
loadDotEnv({ path: path.join(repoRoot, '.env') })

export type AppConfig = {
  host: string
  port: number
  databasePath: string
  trustProxy: boolean
  defaultShell: string
  auth: {
    username: string
    password: string
    sessionTtlMs: number
    ipFailureLimit: number
    ipWindowMs: number
    globalFailureLimit: number
    globalCooldownMs: number
    cookieName: string
  }
  terminal: {
    cols: number
    rows: number
    scrollback: number
  }
  weixin: {
    enabled: boolean
    baseUrl: string
    apiKey: string
    accountId: string
    pollIntervalMs: number
    mediaMaxBytes: number
    mediaRetentionMs: number
    approvalMode: 'ask' | 'auto'
  }
}

function getDefaultDbPath(): string {
  return path.join(os.homedir(), '.worktreehub', 'worktreehub.sqlite')
}

function getPlatformDefaultShell(): string {
  if (process.platform === 'win32') {
    return 'powershell.exe'
  }
  if (process.platform === 'darwin') {
    return process.env.SHELL || '/bin/zsh'
  }
  return process.env.SHELL || '/bin/bash'
}

export function getConfig(): AppConfig {
  const username = process.env.WORKTREEHUB_AUTH_USERNAME?.trim()
  const password = process.env.WORKTREEHUB_AUTH_PASSWORD ?? ''

  if (!username || !password) {
    throw new Error('WORKTREEHUB_AUTH_USERNAME and WORKTREEHUB_AUTH_PASSWORD must be set in the root .env file')
  }

  const weixinServiceEnvPath = process.env.WORKTREEHUB_WEIXIN_SERVICE_ENV?.trim()
  const weixinServiceEnv = weixinServiceEnvPath
    ? parseDotEnv(fs.readFileSync(weixinServiceEnvPath, 'utf8'))
    : {}
  const weixinPort = weixinServiceEnv.PORT || '47890'

  return {
    host: process.env.WORKTREEHUB_HOST ?? '127.0.0.1',
    port: Number(process.env.WORKTREEHUB_PORT ?? 3767),
    databasePath: process.env.WORKTREEHUB_DB ?? getDefaultDbPath(),
    trustProxy: process.env.WORKTREEHUB_TRUST_PROXY !== '0',
    defaultShell: getPlatformDefaultShell(),
    auth: {
      username,
      password,
      sessionTtlMs: Number(process.env.WORKTREEHUB_AUTH_SESSION_TTL_MS ?? 12 * 60 * 60 * 1000),
      ipFailureLimit: Number(process.env.WORKTREEHUB_AUTH_IP_FAILURE_LIMIT ?? 5),
      ipWindowMs: Number(process.env.WORKTREEHUB_AUTH_IP_WINDOW_MS ?? 15 * 60 * 1000),
      globalFailureLimit: Number(process.env.WORKTREEHUB_AUTH_GLOBAL_FAILURE_LIMIT ?? 10),
      globalCooldownMs: Number(process.env.WORKTREEHUB_AUTH_GLOBAL_COOLDOWN_MS ?? 15 * 60 * 1000),
      cookieName: 'worktreehub_session',
    },
    terminal: {
      cols: 120,
      rows: 30,
      scrollback: 10000,
    },
    weixin: {
      enabled: process.env.WORKTREEHUB_WEIXIN_ENABLED === '1',
      baseUrl: (process.env.WORKTREEHUB_WEIXIN_BASE_URL ?? `http://127.0.0.1:${weixinPort}`).replace(/\/$/, ''),
      apiKey: process.env.WORKTREEHUB_WEIXIN_API_KEY ?? weixinServiceEnv.API_KEY ?? '',
      accountId: process.env.WORKTREEHUB_WEIXIN_ACCOUNT_ID ?? '',
      pollIntervalMs: Number(process.env.WORKTREEHUB_WEIXIN_POLL_INTERVAL_MS ?? 2000),
      mediaMaxBytes: Number(process.env.WORKTREEHUB_WEIXIN_MEDIA_MAX_BYTES ?? 20 * 1024 * 1024),
      mediaRetentionMs: Number(process.env.WORKTREEHUB_WEIXIN_MEDIA_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000),
      approvalMode: process.env.WORKTREEHUB_WEIXIN_APPROVAL_MODE === 'auto' ? 'auto' : 'ask',
    },
  }
}
