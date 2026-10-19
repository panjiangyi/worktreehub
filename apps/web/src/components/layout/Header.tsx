import { Menu, PanelLeftClose, PanelLeftOpen, Terminal, Plus, RefreshCw, Settings, FolderOpen, LogOut, WifiOff } from 'lucide-react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { useAuthStore } from '../../stores/auth.store.js'
import { useLayoutStore } from '../../stores/layout.store.js'
import { useUiStore } from '../../stores/ui.store.js'
import { useTerminalStore } from '../../stores/terminal.store.js'
import { useProjectStore } from '../../stores/project.store.js'
import { terminalSocket } from '../../ws/terminal-socket.js'

function getMobileTitle(params: {
  activeTerminal: ReturnType<typeof useTerminalStore.getState>['terminals'][number] | null
  activeProject: ReturnType<typeof useProjectStore.getState>['projects'][number] | null
  activeWorktree: ReturnType<typeof useProjectStore.getState>['worktreesByProjectId'][string][number] | null
}) {
  const { activeTerminal, activeProject, activeWorktree } = params

  if (!activeTerminal) return 'WorktreeHub'

  if (activeTerminal.scopeType === 'directory') {
    return activeTerminal.scopeLabel || 'Directory Terminal'
  }

  if (!activeProject) return 'WorktreeHub'

  const alias = activeWorktree?.displayName || activeWorktree?.name
  const fallback = activeWorktree?.branch || null
  const worktreeLabel = alias || fallback

  return worktreeLabel ? `${activeProject.name} / ${worktreeLabel}` : activeProject.name
}

export function Header() {
  const logout = useAuthStore((s) => s.logout)
  const openDialog = useUiStore((s) => s.openDialog)
  const toggleMobileSidebar = useUiStore((s) => s.toggleMobileSidebar)
  const toggleDesktopSidebar = useUiStore((s) => s.toggleDesktopSidebar)
  const isDesktopSidebarCollapsed = useUiStore((s) => s.isDesktopSidebarCollapsed)
  const terminals = useTerminalStore((s) => s.terminals)
  const activeScopeId = useTerminalStore((s) => s.activeScopeId)
  const projects = useProjectStore((s) => s.projects)
  const worktreesByProjectId = useProjectStore((s) => s.worktreesByProjectId)
  const refreshProject = useProjectStore((s) => s.refreshProject)

  const runningTerminals = terminals.filter((t) => t.status === 'running')
  const runningCount = runningTerminals.length
  const activeTerminal = activeScopeId
    ? terminals.find((terminal) => terminal.scopeId === activeScopeId) ?? null
    : null

  const activeProject = activeTerminal?.scopeType === 'worktree'
    ? projects.find((p) =>
        (worktreesByProjectId[p.id] ?? []).some((wt) => wt.id === activeTerminal.worktreeId)
      ) ?? null
    : null
  const activeWorktree = activeProject && activeTerminal?.worktreeId
    ? (worktreesByProjectId[activeProject.id] ?? []).find((wt) => wt.id === activeTerminal.worktreeId) ?? null
    : null
  const mobileTitle = getMobileTitle({ activeTerminal, activeProject, activeWorktree })

  const handleRefreshAll = async () => {
    for (const project of projects) {
      await refreshProject(project.id)
    }
  }

  const handleLogout = async () => {
    terminalSocket.disconnect()
    try {
      await logout()
    } finally {
      useProjectStore.setState({
        projects: [],
        worktreesByProjectId: {},
        loading: false,
        error: null,
      })
      useTerminalStore.setState({
        terminals: [],
        activeScopeId: null,
        loading: false,
        error: null,
      })
      useLayoutStore.setState({
        activeScopeId: null,
        terminalIdToTitle: {},
      })
      useUiStore.setState({
        activeDialog: null,
        activeDialogData: undefined,
        isMobileSidebarOpen: false,
      })
    }
  }

  return (
    <header className="h-12 border-b app-panel flex items-center px-3 md:px-4 gap-2 md:gap-4">
      <button
        onClick={toggleMobileSidebar}
        className="app-icon-button p-2 md:hidden"
        aria-label="Open projects menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      <div className="hidden md:flex items-center gap-2 font-semibold">
        <Terminal className="w-5 h-5 app-success" />
        <span>WorktreeHub</span>
      </div>

      <button
        onClick={toggleDesktopSidebar}
        className="app-icon-button p-2 hidden md:inline-flex"
        aria-label={isDesktopSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={isDesktopSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {isDesktopSidebarCollapsed ? <PanelLeftOpen className="w-4 h-4" /> : <PanelLeftClose className="w-4 h-4" />}
      </button>

      <div
        className="md:hidden min-w-0 flex-1 text-sm font-medium truncate"
        title={mobileTitle}
      >
        {mobileTitle}
      </div>

      <button
        onClick={() => openDialog('addProject')}
        className="app-button-secondary hidden md:flex items-center gap-1 py-1.5"
      >
        <Plus className="w-4 h-4" />
        Add Project
      </button>

      <button
        onClick={() => openDialog('openDirectoryTerminal')}
        className="app-button-secondary hidden md:flex items-center gap-1 py-1.5"
      >
        <FolderOpen className="w-4 h-4" />
        Open Terminal
      </button>

      <button
        onClick={handleRefreshAll}
        className="app-button-secondary hidden md:flex items-center gap-1 py-1.5"
      >
        <RefreshCw className="w-4 h-4" />
        Refresh
      </button>

      <button
        onClick={() => terminalSocket.reconnect()}
        className="app-button-secondary hidden md:flex items-center gap-1 py-1.5"
        title="Reconnect WebSocket without page reload"
      >
        <WifiOff className="w-4 h-4" />
        Reconnect
      </button>

      <div className="hidden md:block flex-1" />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="app-icon-button flex items-center gap-1.5 px-2 py-1.5 text-xs md:text-sm"
            aria-label={`Show running terminals (${runningCount})`}
            title="Show running terminals"
          >
            <Terminal className="w-4 h-4" />
            <span className="hidden md:inline">Running:</span>
            <span>{runningCount}</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={8}
            collisionPadding={12}
            className="app-panel z-50 w-96 max-w-[calc(100vw-24px)] rounded-lg border p-1 shadow-xl overflow-y-auto max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))]"
          >
            <DropdownMenu.Label className="px-3 py-2 text-sm font-medium">
              Running terminals ({runningCount})
            </DropdownMenu.Label>
            {runningCount === 0 && (
              <div className="px-3 py-4 text-sm app-muted">No running terminals</div>
            )}
            {runningTerminals.map((terminal) => {
              const project = projects.find((item) => item.id === terminal.projectId)
              const worktree = terminal.projectId
                ? (worktreesByProjectId[terminal.projectId] ?? []).find((item) => item.id === terminal.worktreeId)
                : null
              const scopeLabel = [project?.name, worktree?.displayName || worktree?.name || terminal.scopeLabel]
                .filter(Boolean).join(' / ')

              return (
                <DropdownMenu.Item
                  key={terminal.id}
                  textValue={`${terminal.title} ${scopeLabel} ${terminal.cwd}`}
                  onSelect={() => {
                    useTerminalStore.getState().setActiveScope(terminal.scopeId)
                    useLayoutStore.getState().addPaneForTerminal(terminal.scopeId, terminal.id, terminal.title)
                  }}
                  className="app-hover flex cursor-pointer items-start gap-2 rounded px-3 py-2 outline-none data-[highlighted]:bg-[var(--color-panel-hover)]"
                >
                  <Terminal className="app-success mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{terminal.title}</div>
                    <div className="truncate text-xs app-muted">{scopeLabel}</div>
                    <div className="truncate text-xs app-subtle" title={terminal.cwd}>{terminal.cwd}</div>
                  </div>
                </DropdownMenu.Item>
              )
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <button
        onClick={() => openDialog('openDirectoryTerminal')}
        className="app-icon-button p-2 md:hidden"
        title="Open terminal"
      >
        <FolderOpen className="w-4 h-4" />
      </button>

      <button
        onClick={() => terminalSocket.reconnect()}
        className="app-icon-button p-2 md:hidden"
        title="Reconnect"
      >
        <WifiOff className="w-4 h-4" />
      </button>

      <button
        onClick={() => openDialog('settings')}
        className="app-icon-button p-2"
      >
        <Settings className="w-4 h-4" />
      </button>

      <button
        onClick={() => void handleLogout()}
        className="app-icon-button p-2"
        title="Log out"
      >
        <LogOut className="w-4 h-4" />
      </button>
    </header>
  )
}
