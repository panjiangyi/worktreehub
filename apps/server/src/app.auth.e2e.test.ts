import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import type { AppConfig } from './config.js'

const tempDirs: string[] = []

function createConfig(rootPath: string): AppConfig {
  return {
    host: '127.0.0.1',
    port: 3767,
    databasePath: path.join(rootPath, 'app.db'),
    trustProxy: true,
    defaultShell: '/bin/bash',
    auth: {
      username: 'admin',
      password: 's3cret-pass',
      sessionTtlMs: 12 * 60 * 60 * 1000,
      ipFailureLimit: 5,
      ipWindowMs: 15 * 60 * 1000,
      globalFailureLimit: 10,
      globalCooldownMs: 15 * 60 * 1000,
      cookieName: 'worktreehub_session',
    },
    terminal: {
      cols: 120,
      rows: 30,
      scrollback: 10000,
    },
  }
}

async function createTestApp() {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'worktreehub-auth-test-'))
  tempDirs.push(rootPath)
  const app = await buildApp(createConfig(rootPath))
  return app
}

function getSessionCookie(setCookieHeader: string | undefined): string {
  if (!setCookieHeader) {
    throw new Error('Missing Set-Cookie header')
  }
  return setCookieHeader.split(';', 1)[0]
}

afterEach(async () => {
  const dirs = tempDirs.splice(0)
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('app auth', () => {
  it('requires auth for business APIs and returns session info after login', async () => {
    const app = await createTestApp()

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/projects',
    })
    expect(unauthorized.statusCode).toBe(401)

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      payload: {
        username: 'admin',
        password: 's3cret-pass',
      },
    })

    expect(login.statusCode).toBe(204)
    expect(login.headers['set-cookie']).toBeDefined()
    expect(String(login.headers['set-cookie'])).toContain('HttpOnly')
    expect(String(login.headers['set-cookie'])).toContain('SameSite=Strict')
    expect(String(login.headers['set-cookie'])).toContain('Secure')

    const cookie = getSessionCookie(
      Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']
    )

    const session = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: {
        worktreehub_session: cookie.split('=')[1],
      },
    })

    expect(session.statusCode).toBe(200)
    expect(session.json()).toMatchObject({
      authenticated: true,
      username: 'admin',
    })

    const projects = await app.inject({
      method: 'GET',
      url: '/api/projects',
      cookies: {
        worktreehub_session: cookie.split('=')[1],
      },
    })
    expect(projects.statusCode).toBe(200)
    expect(projects.json()).toEqual([])

    await app.close()
  })

  it('rejects invalid origin and rate limits repeated login failures', async () => {
    const app = await createTestApp()

    const originMismatch = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        host: 'example.test',
        origin: 'https://evil.test',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      payload: {
        username: 'admin',
        password: 's3cret-pass',
      },
    })

    expect(originMismatch.statusCode).toBe(403)

    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: {
          host: 'example.test',
          origin: 'https://example.test',
          'x-forwarded-proto': 'https',
          'content-type': 'application/json',
        },
        payload: {
          username: 'admin',
          password: 'wrong-pass',
        },
      })
      expect(response.statusCode).toBe(401)
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        host: 'example.test',
        origin: 'https://example.test',
        'x-forwarded-proto': 'https',
        'content-type': 'application/json',
      },
      payload: {
        username: 'admin',
        password: 'wrong-pass',
      },
    })
    expect(limited.statusCode).toBe(429)

    await app.close()
  })

  it('invalidates sessions on logout and enforces websocket auth during handshake', async () => {
    const app = await createTestApp()
    await app.listen({ host: '127.0.0.1', port: 0 })

    const address = app.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP server address')
    }

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        host: `127.0.0.1:${address.port}`,
        origin: `http://127.0.0.1:${address.port}`,
        'content-type': 'application/json',
      },
      payload: {
        username: 'admin',
        password: 's3cret-pass',
      },
    })

    const cookie = getSessionCookie(
      Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'][0] : login.headers['set-cookie']
    )

    const unauthorizedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal`, {
      headers: {
        origin: `http://127.0.0.1:${address.port}`,
      },
    })

    await new Promise<void>((resolve, reject) => {
      unauthorizedSocket.once('error', () => resolve())
      unauthorizedSocket.once('unexpected-response', () => resolve())
      unauthorizedSocket.once('open', () => reject(new Error('Unauthorized websocket should not connect')))
    })

    const authorizedSocket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/terminal`, {
      headers: {
        origin: `http://127.0.0.1:${address.port}`,
        cookie,
      },
    })

    await once(authorizedSocket, 'open')

    const logoutPromise = once(authorizedSocket, 'close')
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        host: `127.0.0.1:${address.port}`,
        origin: `http://127.0.0.1:${address.port}`,
        'content-type': 'application/json',
      },
      cookies: {
        worktreehub_session: cookie.split('=')[1],
      },
      payload: {},
    })

    expect(logout.statusCode).toBe(204)
    await logoutPromise

    const sessionAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      cookies: {
        worktreehub_session: cookie.split('=')[1],
      },
    })

    expect(sessionAfterLogout.json()).toEqual({ authenticated: false })
    await app.close()
  })
})
