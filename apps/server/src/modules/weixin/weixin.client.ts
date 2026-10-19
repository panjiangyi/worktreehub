import type { AppConfig } from '../../config.js'

export type WeixinMedia = { id: string; type: 'image' | 'video' | 'file'; mime: string; size: number; filename?: string; url: string }
export type WeixinMessage = {
  seq: number
  user: string
  direction: 'in' | 'out'
  text: string
  media: WeixinMedia | null
  timestamp: number
  received_at: number
}

type AccountSummary = { id: string; label?: string; poller?: { state?: string } }

export class WeixinClient {
  constructor(private config: AppConfig['weixin']) {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      ...init,
      headers: { 'X-API-Key': this.config.apiKey, ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`Weixin API ${response.status}: ${(await response.text()).slice(0, 500)}`)
    return response
  }

  private accountPath(path: string): string {
    return `/accounts/${encodeURIComponent(this.config.accountId)}${path}`
  }

  async health(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      return response.ok
    } catch {
      return false
    }
  }

  async status(): Promise<{ connected: boolean; account: AccountSummary | null }> {
    const connected = await this.health()
    if (!connected) return { connected: false, account: null }

    if (!this.config.apiKey) {
      return { connected: true, account: null }
    }

    try {
      const response = await this.request('/accounts')
      const body = await response.json() as { accounts: AccountSummary[] }
      return { connected: true, account: body.accounts.find((account) => account.id === this.config.accountId) ?? null }
    } catch {
      return { connected: true, account: null }
    }
  }

  async messages(since: number, limit = 200, signal?: AbortSignal): Promise<{ messages: WeixinMessage[]; next_cursor: number; has_more: boolean }> {
    const response = await this.request(this.accountPath(`/messages?since=${since}&limit=${limit}`), { signal })
    return await response.json() as { messages: WeixinMessage[]; next_cursor: number; has_more: boolean }
  }

  async sendText(userId: string, text: string): Promise<void> {
    await this.request(this.accountPath('/send'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: userId, text }),
    })
  }

  async sendFile(userId: string, path: string, filename: string, mime: string): Promise<void> {
    const { readFile } = await import('node:fs/promises')
    const bytes = await readFile(path)
    const form = new FormData()
    form.set('to', userId)
    form.set('file', new File([bytes], filename, { type: mime }))
    await this.request(this.accountPath('/send/media'), { method: 'POST', body: form })
  }

  async downloadMedia(media: WeixinMedia): Promise<ArrayBuffer> {
    const response = await this.request(media.url)
    const length = Number(response.headers.get('content-length') ?? media.size)
    if (length > this.config.mediaMaxBytes) throw new Error(`Attachment exceeds ${this.config.mediaMaxBytes} bytes`)
    const data = await response.arrayBuffer()
    if (data.byteLength > this.config.mediaMaxBytes) throw new Error(`Attachment exceeds ${this.config.mediaMaxBytes} bytes`)
    return data
  }
}
