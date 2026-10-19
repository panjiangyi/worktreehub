import { useEffect, useState } from 'react'
import { Bot, Check, Copy, Link2, Loader2, Plus, RefreshCw, Unlink, X, Info, Monitor, Moon, Sun } from 'lucide-react'
import type { AgentDefinition, WeixinIntegrationStatus } from '@worktreehub/shared'
import { useUiStore } from '../../stores/ui.store.js'
import { type ThemeMode, useThemeStore } from '../../stores/theme.store.js'
import { weixinApi } from '../../api/weixin.api.js'

export function SettingsDialog() {
  const closeDialog = useUiStore((s) => s.closeDialog)
  const themeMode = useThemeStore((s) => s.themeMode)
  const setThemeMode = useThemeStore((s) => s.setThemeMode)

  const [selectedThemeMode, setSelectedThemeMode] = useState<ThemeMode>(themeMode)
  const [weixin, setWeixin] = useState<WeixinIntegrationStatus | null>(null)
  const [health, setHealth] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const [loadingWeixin, setLoadingWeixin] = useState(true)
  const [weixinError, setWeixinError] = useState<string | null>(null)
  const [showAgentForm, setShowAgentForm] = useState(false)
  const [agentName, setAgentName] = useState('')
  const [agentExecutable, setAgentExecutable] = useState('')
  const [agentArgs, setAgentArgs] = useState('["{prompt}"]')

  const loadWeixin = async () => {
    setLoadingWeixin(true)
    setWeixinError(null)
    try {
      const [status, checks] = await Promise.all([weixinApi.status(), weixinApi.health()])
      setWeixin(status)
      setHealth(Object.fromEntries(checks.map((item) => [item.id, item])))
    } catch (error) { setWeixinError((error as Error).message) }
    finally { setLoadingWeixin(false) }
  }

  const refreshStatus = async () => {
    try { setWeixin(await weixinApi.status()) } catch (error) { setWeixinError((error as Error).message) }
  }

  useEffect(() => {
    void loadWeixin()
    const timer = window.setInterval(() => void refreshStatus(), 5000)
    return () => window.clearInterval(timer)
  }, [])

  const createPairing = async () => {
    try { await weixinApi.pair(); await loadWeixin() } catch (error) { setWeixinError((error as Error).message) }
  }

  const unbind = async () => {
    if (!window.confirm('Unbind the current WeChat owner? Active tasks will be stopped and coding conversation metadata will be removed.')) return
    try { await weixinApi.unbind(); await loadWeixin() } catch (error) { setWeixinError((error as Error).message) }
  }

  const saveCustomAgent = async () => {
    try {
      const args = JSON.parse(agentArgs) as unknown
      if (!Array.isArray(args) || !args.every((item) => typeof item === 'string')) throw new Error('Arguments must be a JSON string array')
      const id = agentName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
      const agent: AgentDefinition = { id, name: agentName.trim(), kind: 'command', executable: agentExecutable.trim(),
        enabled: true, capabilities: ['streaming'], config: { args } }
      await weixinApi.saveAgent(agent)
      setShowAgentForm(false); setAgentName(''); setAgentExecutable(''); await loadWeixin()
    } catch (error) { setWeixinError((error as Error).message) }
  }

  const handleSave = () => {
    setThemeMode(selectedThemeMode)
    closeDialog()
  }

  return (
    <div className="app-dialog-overlay">
      <div className="app-dialog app-dialog-mobile max-w-[680px] max-h-[90vh] overflow-y-auto">
        <div className="app-dialog-header">
          <h2 className="text-lg font-medium">Settings</h2>
          <button onClick={closeDialog} className="app-icon-button">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">
              Theme
            </label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setSelectedThemeMode('system')}
                className={`rounded-md border px-3 py-2 text-sm ${
                  selectedThemeMode === 'system' ? 'app-soft-info app-accent border-[var(--color-accent)]' : 'app-panel-strong app-hover'
                }`}
              >
                <Monitor className="w-4 h-4 mx-auto mb-1" />
                System
              </button>
              <button
                type="button"
                onClick={() => setSelectedThemeMode('light')}
                className={`rounded-md border px-3 py-2 text-sm ${
                  selectedThemeMode === 'light' ? 'app-soft-info app-accent border-[var(--color-accent)]' : 'app-panel-strong app-hover'
                }`}
              >
                <Sun className="w-4 h-4 mx-auto mb-1" />
                Light
              </button>
              <button
                type="button"
                onClick={() => setSelectedThemeMode('dark')}
                className={`rounded-md border px-3 py-2 text-sm ${
                  selectedThemeMode === 'dark' ? 'app-soft-info app-accent border-[var(--color-accent)]' : 'app-panel-strong app-hover'
                }`}
              >
                <Moon className="w-4 h-4 mx-auto mb-1" />
                Dark
              </button>
            </div>
            <p className="app-subtle text-xs mt-1">System follows your OS preference automatically.</p>
          </div>

          <div className="flex items-start gap-2 p-3 app-soft-info rounded">
            <Info className="w-4 h-4 app-accent flex-shrink-0 mt-0.5" />
            <div className="text-xs app-muted">
              <p>Authentication is tied to the current site origin.</p>
              <p className="mt-1">API routing now uses the current site origin only, so runtime API overrides are disabled.</p>
            </div>
          </div>

          <div className="border-t border-[var(--color-border)] pt-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Bot className="w-4 h-4" />
                <div><p className="text-sm font-medium">WeChat Coding</p><p className="text-xs app-subtle">Single-owner remote coding</p></div>
              </div>
              <button type="button" className="app-icon-button" title="Refresh status" onClick={() => void loadWeixin()}>
                <RefreshCw className={`w-4 h-4 ${loadingWeixin ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {loadingWeixin && !weixin ? <div className="flex items-center gap-2 text-sm app-muted"><Loader2 className="w-4 h-4 animate-spin" />Checking service</div> : null}
            {weixin && (
              <div className="app-panel-strong border border-[var(--color-border)] rounded-md p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between"><span>Integration</span><span className={weixin.enabled ? 'app-success' : 'app-subtle'}>{weixin.enabled ? 'Enabled' : 'Disabled'}</span></div>
                <div className="flex items-center justify-between"><span>Sidecar</span><span className={weixin.connected ? 'app-success' : 'app-danger'}>{weixin.connected ? 'Connected' : 'Unavailable'}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Account</span><span className="truncate app-muted">{weixin.accountLabel || weixin.accountId || 'Not configured'}</span></div>
                <div className="flex items-center justify-between gap-3"><span>Owner</span><span className="truncate app-muted">{weixin.owner?.displayName || weixin.owner?.userId || 'Not paired'}</span></div>
                <div className="flex items-center justify-between"><span>Approvals</span><span className={weixin.approvalMode === 'auto' ? 'app-danger' : 'app-muted'}>{weixin.approvalMode === 'auto' ? 'Auto approve' : 'Ask in WeChat'}</span></div>
                {weixin.currentTask && <div className="flex items-center justify-between"><span>Current task</span><span className="app-muted">{weixin.currentTask.id.slice(-6)} · {weixin.currentTask.status}</span></div>}
              </div>
            )}

            {weixin?.pairing && !weixin.owner && (
              <div className="app-soft-info rounded-md p-3">
                <p className="text-sm font-medium">Send this code to the bot</p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="text-xl flex-1 tracking-widest">{weixin.pairing.code}</code>
                  <button type="button" className="app-icon-button" title="Copy pairing code" onClick={() => void navigator.clipboard.writeText(weixin.pairing!.code)}><Copy className="w-4 h-4" /></button>
                </div>
                <p className="text-xs app-subtle mt-1">Expires {new Date(weixin.pairing.expiresAt).toLocaleTimeString()}</p>
              </div>
            )}

            <div className="flex gap-2">
              {!weixin?.owner ? <button type="button" className="app-button-secondary flex items-center gap-1.5" disabled={!weixin?.configured} onClick={() => void createPairing()}><Link2 className="w-4 h-4" />Pair owner</button>
                : <button type="button" className="app-button-danger flex items-center gap-1.5" onClick={() => void unbind()}><Unlink className="w-4 h-4" />Unbind</button>}
            </div>

            <div className="pt-2">
              <div className="flex items-center justify-between mb-2"><p className="text-sm font-medium">Agent Drivers</p><button type="button" className="app-icon-button" title="Add command driver" onClick={() => setShowAgentForm((value) => !value)}><Plus className="w-4 h-4" /></button></div>
              <div className="space-y-1.5">
                {weixin?.agents.map((agent) => <div key={agent.id} className="flex items-center gap-2 text-sm border border-[var(--color-border)] rounded-md px-3 py-2">
                  {health[agent.id]?.ok ? <Check className="w-4 h-4 app-success" /> : <X className="w-4 h-4 app-danger" />}
                  <span className="font-medium">{agent.name}</span><span className="app-subtle truncate flex-1">{agent.capabilities.join(', ')}</span>
                  <span className="text-xs app-subtle" title={health[agent.id]?.detail}>{health[agent.id]?.ok ? 'Ready' : 'Unavailable'}</span>
                </div>)}
              </div>
            </div>

            {showAgentForm && <div className="border border-[var(--color-border)] rounded-md p-3 space-y-2">
              <input className="app-input" placeholder="Agent name" value={agentName} onChange={(event) => setAgentName(event.target.value)} />
              <input className="app-input font-mono" placeholder="Executable, e.g. aider" value={agentExecutable} onChange={(event) => setAgentExecutable(event.target.value)} />
              <textarea className="app-input font-mono text-sm" rows={2} value={agentArgs} onChange={(event) => setAgentArgs(event.target.value)} />
              <p className="text-xs app-subtle">Arguments are a JSON array. Available tokens: {'{prompt}'}, {'{cwd}'}, {'{session}'}, {'{images}'}.</p>
              <button type="button" className="app-button-primary" disabled={!agentName.trim() || !agentExecutable.trim()} onClick={() => void saveCustomAgent()}>Add driver</button>
            </div>}
            {weixinError && <div className="app-soft-danger app-danger text-sm rounded px-3 py-2">{weixinError}</div>}
          </div>

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button
              onClick={closeDialog}
              className="app-button-secondary"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="app-button-primary"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
