import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ReactGridLayout } from 'react-grid-layout/legacy'
import type { LayoutItem } from 'react-grid-layout'
import 'react-grid-layout/css/styles.css'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Maximize2, Mic, Minimize2, Plus, X } from 'lucide-react'
import { GRID_COLS, GRID_ROWS, useLayoutStore } from '../../stores/layout.store.js'
import { useTerminalStore } from '../../stores/terminal.store.js'
import { useMediaQuery } from '../../hooks/useMediaQuery.js'
import { CloseTerminalDialog } from './CloseTerminalDialog.js'
import { TerminalPane } from './TerminalPane.js'
import { TerminalTitleField } from './TerminalTitleField.js'
import type { TerminalViewActions } from './XtermView.js'

type MaximizeState = {
  maximizedTerminalId: string | null
  setMaximizedTerminalId: (terminalId: string | null) => void
}

const MARGIN = 8
const KEYBOARD_KEYS_MARGIN_PX = 8
// Vertical gap between the Enter key and the interrupt (Ctrl+C) key above it —
// wide enough that a thumb reaching for Enter can't accidentally graze
// Ctrl+C and kill the running command.
const INTERRUPT_KEY_OFFSET_PX = 56
const EXTRA_RIGHT_KEY_OFFSET_PX = 112
// Tab now aligns with the Escape key so the floating controls read as two
// clean columns on small mobile widths.
const EXTRA_LEFT_KEY_OFFSET_PX = EXTRA_RIGHT_KEY_OFFSET_PX
// position: fixed anchors to the layout viewport, which iOS/Android don't
// shrink when the virtual keyboard opens — only visualViewport does. Track it
// so fixed overlays can be pushed up above the keyboard instead of ending up
// hidden underneath it.
function useKeyboardBottomInset(): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const update = () => {
      const covered = window.innerHeight - (viewport.offsetTop + viewport.height)
      setInset(Math.max(0, Math.round(covered)))
    }

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])

  return inset
}

export function TerminalGrid() {
  const isMobile = useMediaQuery('(max-width: 767px)')
  const activeScopeId = useLayoutStore((s) => s.activeScopeId)
  const layoutsByScopeId = useLayoutStore((s) => s.layoutsByScopeId)
  const [maximizedTerminalId, setMaximizedTerminalId] = useState<string | null>(null)

  useEffect(() => {
    if (!maximizedTerminalId) return
    const ownerScopeId = Object.keys(layoutsByScopeId).find((scopeId) =>
      (layoutsByScopeId[scopeId] ?? []).some((item) => item.i === maximizedTerminalId)
    )
    if (!ownerScopeId || ownerScopeId !== activeScopeId) {
      setMaximizedTerminalId(null)
    }
  }, [activeScopeId, layoutsByScopeId, maximizedTerminalId])

  const maximizeState = { maximizedTerminalId, setMaximizedTerminalId }
  if (isMobile) return <MobileTerminalFocus {...maximizeState} />
  return <DesktopTerminalGrid {...maximizeState} />
}

function DesktopTerminalGrid({ maximizedTerminalId, setMaximizedTerminalId }: MaximizeState) {
  const activeScopeId = useLayoutStore((s) => s.activeScopeId)
  const layoutsByScopeId = useLayoutStore((s) => s.layoutsByScopeId)
  const setLayoutForScope = useLayoutStore((s) => s.setLayoutForScope)
  const terminalIdToTitle = useLayoutStore((s) => s.terminalIdToTitle)
  const closeTerminal = useTerminalStore((s) => s.closeTerminal)
  const renameTerminal = useTerminalStore((s) => s.renameTerminal)
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)

  const [size, setSize] = useState({ width: 0, height: 0 })
  const observerRef = useRef<ResizeObserver | null>(null)

  const measureRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!el) return
    const rect = el.getBoundingClientRect()
    setSize({ width: rect.width, height: rect.height })
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect
      if (r) setSize({ width: r.width, height: r.height })
    })
    observer.observe(el)
    observerRef.current = observer
  }, [])

  // Render every open scope's grid and keep them all mounted, toggling
  // visibility with CSS. Unmounting a scope's terminals on tab switch would
  // force a re-attach and a full scrollback replay when switching back.
  const scopeIds = useMemo(
    () => Object.keys(layoutsByScopeId).filter((id) => (layoutsByScopeId[id]?.length ?? 0) > 0),
    [layoutsByScopeId]
  )

  const rowHeight = useMemo(() => {
    if (size.height <= 0) return 30
    const usable = size.height - (GRID_ROWS - 1) * MARGIN - 2 * MARGIN
    return Math.max(20, usable / GRID_ROWS)
  }, [size.height])

  const handleLayoutChange = useCallback(
    (scopeId: string, newLayout: readonly LayoutItem[]) => {
      if (
        maximizedTerminalId &&
        newLayout.some((item) => item.i === maximizedTerminalId)
      ) {
        return
      }
      if (newLayout.length > 0) {
        setLayoutForScope(scopeId, [...newLayout])
      }
    },
    [maximizedTerminalId, setLayoutForScope]
  )

  const requestClose = useCallback((terminalId: string) => {
    setPendingCloseId(terminalId)
  }, [])

  const cancelClose = useCallback(() => {
    setPendingCloseId(null)
  }, [])

  const confirmClose = useCallback(() => {
    if (!pendingCloseId) return
    const terminalId = pendingCloseId
    setPendingCloseId(null)
    void closeTerminal(terminalId)
  }, [closeTerminal, pendingCloseId])

  if (scopeIds.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center app-subtle">
        <div className="text-center">
          <p className="text-lg mb-2">No terminal opened</p>
          <p className="text-sm">Select a worktree or open a directory terminal.</p>
        </div>
      </div>
    )
  }

  return (
    <div ref={measureRef} className="terminal-grid relative flex-1 min-h-0 overflow-hidden">
      {size.width > 0 &&
        size.height > 0 &&
        scopeIds.map((scopeId) => {
          const scopeLayout = layoutsByScopeId[scopeId] ?? []
          const isActive = scopeId === activeScopeId
          return (
            <div
              key={scopeId}
              className="absolute inset-0"
              style={{ display: isActive ? 'block' : 'none' }}
              aria-hidden={!isActive}
            >
              <ReactGridLayout
                layout={scopeLayout}
                width={size.width}
                cols={GRID_COLS}
                maxRows={GRID_ROWS}
                rowHeight={rowHeight}
                margin={[MARGIN, MARGIN]}
                containerPadding={[MARGIN, MARGIN]}
                autoSize={false}
                style={{ height: size.height }}
                onLayoutChange={(newLayout) => handleLayoutChange(scopeId, newLayout)}
                draggableHandle=".drag-handle"
                draggableCancel=".terminal-pane-control"
                resizeHandles={['se']}
                compactType="vertical"
                preventCollision={false}
                isBounded
                isDraggable={!scopeLayout.some((item) => item.i === maximizedTerminalId)}
                isResizable={!scopeLayout.some((item) => item.i === maximizedTerminalId)}
              >
                {scopeLayout.map((item) => {
                  const isMaximized = isActive && maximizedTerminalId === item.i
                  const title = terminalIdToTitle[item.i] || item.i
                  return (
                  <div
                    key={item.i}
                    className={`app-panel border overflow-hidden flex flex-col ${isMaximized ? 'terminal-pane-maximized' : 'rounded'}`}
                  >
                    <div
                      className={`drag-handle flex items-center justify-between gap-1 px-2 py-1 app-panel-strong border-b select-none ${isMaximized ? '' : 'cursor-move'}`}
                      onDoubleClick={(event) => {
                        if (event.target instanceof Element && event.target.closest('.terminal-pane-control')) return
                        setMaximizedTerminalId(isMaximized ? null : item.i)
                      }}
                    >
                      <div className="min-w-0 flex-1 text-xs app-muted">
                        <TerminalTitleField
                          title={title}
                          onRename={(next) => renameTerminal(item.i, next)}
                        />
                      </div>
                      <span className="ml-3 flex shrink-0 items-center">
                        <button
                          type="button"
                          aria-pressed={isMaximized}
                          onClick={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            setMaximizedTerminalId(isMaximized ? null : item.i)
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                          className="terminal-pane-control app-icon-button p-1.5"
                          aria-label={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
                          title={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
                        >
                          {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
                        </button>
                        <span className="mx-3 h-4 w-px shrink-0 bg-[var(--color-border)]" aria-hidden />
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            requestClose(item.i)
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                          className="terminal-pane-control app-icon-button p-1.5"
                          aria-label="Close terminal"
                          title="Close terminal"
                        >
                          <X className="w-3.5 h-3.5 app-danger" />
                        </button>
                      </span>
                    </div>
                    <div className="flex flex-col flex-1 min-h-0">
                      <TerminalPane terminalId={item.i} />
                    </div>
                  </div>
                  )
                })}
              </ReactGridLayout>
            </div>
          )
        })}
      {pendingCloseId && createPortal(
        <CloseTerminalDialog
          title={terminalIdToTitle[pendingCloseId] || pendingCloseId}
          onCancel={cancelClose}
          onConfirm={confirmClose}
        />,
        document.body
      )}
    </div>
  )
}

function MobileTerminalFocus({ maximizedTerminalId, setMaximizedTerminalId }: MaximizeState) {
  const activeScopeId = useLayoutStore((s) => s.activeScopeId)
  const layoutsByScopeId = useLayoutStore((s) => s.layoutsByScopeId)
  const terminalIdToTitle = useLayoutStore((s) => s.terminalIdToTitle)
  const createNewTerminalForScope = useTerminalStore((s) => s.createNewTerminalForScope)
  const closeTerminal = useTerminalStore((s) => s.closeTerminal)
  const renameTerminal = useTerminalStore((s) => s.renameTerminal)
  const [pendingCloseId, setPendingCloseId] = useState<string | null>(null)
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [terminalActions, setTerminalActions] = useState<TerminalViewActions | null>(null)
  const [voiceInputMode, setVoiceInputMode] = useState(false)
  const [voiceDraft, setVoiceDraft] = useState('')
  const previousLayoutLengthRef = useRef(0)
  const previousScopeIdRef = useRef<string | null>(null)

  const layout = useMemo(() => {
    if (!activeScopeId) return []
    return layoutsByScopeId[activeScopeId] ?? []
  }, [activeScopeId, layoutsByScopeId])
  const scopeIds = useMemo(
    () => Object.keys(layoutsByScopeId).filter((id) => (layoutsByScopeId[id]?.length ?? 0) > 0),
    [layoutsByScopeId]
  )

  useEffect(() => {
    if (layout.length === 0) {
      setActiveTerminalId(null)
      setTerminalActions(null)
      setVoiceDraft('')
      return
    }

    const scopeChanged = previousScopeIdRef.current !== activeScopeId
    const terminalAdded = layout.length > previousLayoutLengthRef.current
    previousLayoutLengthRef.current = layout.length
    previousScopeIdRef.current = activeScopeId

    setActiveTerminalId((current) => {
      if (!scopeChanged && !terminalAdded && current && layout.some((item) => item.i === current)) {
        return current
      }
      return layout[layout.length - 1]?.i ?? null
    })
  }, [activeScopeId, layout])

  useEffect(() => {
    if (!voiceInputMode) {
      setVoiceDraft('')
    }
  }, [voiceInputMode])

  const sendKey = useCallback(
    (data: string) => {
      if (!activeTerminalId || !terminalActions) return
      terminalActions.sendInput(data)
      terminalActions.focus()
    },
    [activeTerminalId, terminalActions]
  )

  const keyboardBottomInset = useKeyboardBottomInset()
  const keyPadBottom = keyboardBottomInset + KEYBOARD_KEYS_MARGIN_PX
  const showVoiceDraftOverlay = voiceInputMode || Boolean(voiceDraft)

  const requestCloseTerminal = useCallback((terminalId: string) => {
    setPendingCloseId(terminalId)
  }, [])

  const cancelCloseTerminal = useCallback(() => {
    setPendingCloseId(null)
  }, [])

  const confirmCloseTerminal = useCallback(() => {
    if (!pendingCloseId) return
    const terminalId = pendingCloseId
    setPendingCloseId(null)
    if (terminalId === activeTerminalId) {
      const currentIndex = layout.findIndex((item) => item.i === terminalId)
      const fallbackId =
        layout[currentIndex + 1]?.i ?? layout[currentIndex - 1]?.i ?? null
      setActiveTerminalId(fallbackId)
    }
    void closeTerminal(terminalId)
  }, [activeTerminalId, closeTerminal, layout, pendingCloseId])

  const handleCreateTerminal = useCallback(() => {
    if (!activeScopeId) return
    void createNewTerminalForScope(activeScopeId)
  }, [activeScopeId, createNewTerminalForScope])

  if (!activeScopeId || layout.length === 0 || !activeTerminalId) {
    return (
      <div className="flex-1 flex items-center justify-center app-subtle px-6">
        <div className="text-center">
          <p className="text-lg mb-2">No terminal opened</p>
          <p className="text-sm">Open the projects menu or a directory terminal.</p>
        </div>
      </div>
    )
  }

  const isMaximized = maximizedTerminalId !== null

  return (
    <div className={`mobile-terminal-shell flex-none min-h-0 flex flex-col overflow-hidden ${isMaximized ? 'terminal-pane-maximized' : ''}`}>
      <div className="flex items-center gap-1 border-b app-panel-strong overflow-x-auto px-1 py-1">
        {layout.map((item, index) => {
          const isActive = item.i === activeTerminalId
          const title = terminalIdToTitle[item.i] || `Terminal ${index + 1}`
          return (
            <div
              key={item.i}
              className={`
                flex h-8 min-w-[7rem] max-w-[11rem] shrink-0 items-center gap-1 rounded border px-2 text-xs
                ${isActive ? 'app-panel' : 'app-panel-strong app-muted'}
              `}
            >
              <TerminalTitleField
                title={title}
                onActivate={() => {
                  setActiveTerminalId(item.i)
                  terminalActions?.focus()
                }}
                onRename={(next) => renameTerminal(item.i, next)}
              />
              <button
                type="button"
                aria-label="Close terminal"
                title="Close terminal"
                onClick={() => requestCloseTerminal(item.i)}
                className="app-icon-button flex h-6 w-6 shrink-0 items-center justify-center p-0"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )
        })}
        <button
          type="button"
          aria-label="New terminal"
          title="New terminal"
          onClick={handleCreateTerminal}
          className="app-icon-button flex h-8 w-8 shrink-0 items-center justify-center border p-0"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
          title={isMaximized ? 'Restore terminal' : 'Maximize terminal'}
          aria-pressed={isMaximized}
          onClick={() => {
            if (!activeTerminalId) return
            setMaximizedTerminalId(isMaximized ? null : activeTerminalId)
          }}
          className="app-icon-button flex h-8 w-8 shrink-0 items-center justify-center border p-0"
        >
          {isMaximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
        <button
          type="button"
          aria-label="Voice input mode"
          title="Voice input mode"
          aria-pressed={voiceInputMode}
          onPointerDown={(event) => {
            event.preventDefault()
            setVoiceInputMode((enabled) => !enabled)
            requestAnimationFrame(() => terminalActions?.focus())
          }}
          className={`app-icon-button flex h-8 w-8 shrink-0 items-center justify-center border p-0 ${voiceInputMode ? 'app-success' : ''}`}
        >
          <Mic className={`h-4 w-4 ${voiceInputMode ? 'fill-current' : ''}`} />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 app-panel flex flex-col overflow-hidden">
        {scopeIds.map((scopeId) => {
          const isActiveScope = scopeId === activeScopeId
          return (layoutsByScopeId[scopeId] ?? []).map((item) => {
            const isActive = isActiveScope && item.i === activeTerminalId
            return (
              <div
                key={item.i}
                className="absolute inset-0 flex min-h-0 flex-col"
                style={{ display: isActive ? 'flex' : 'none' }}
                aria-hidden={!isActive}
              >
                <TerminalPane
                  terminalId={item.i}
                  fontSize={12}
                  voiceInputMode={isActive && voiceInputMode}
                  onActionsChange={isActive ? setTerminalActions : undefined}
                  onVoiceDraftChange={isActive ? setVoiceDraft : undefined}
                />
              </div>
            )
          })
        })}
      </div>

      {createPortal(
        <>
          {showVoiceDraftOverlay && (
            <div className="pointer-events-none fixed inset-x-0 top-0 z-[48] px-3 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
              <div className="mx-auto flex max-w-screen-md items-start gap-2 rounded-md border px-3 py-2 shadow-lg backdrop-blur-sm app-panel">
                <div className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${voiceInputMode ? 'bg-emerald-500' : 'app-muted bg-current/40'}`} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-[0.08em] app-muted">
                    {voiceInputMode ? 'Voice Input' : 'Input Complete'}
                  </div>
                  <div className="min-h-[1.25rem] break-words text-sm leading-5">
                    {voiceDraft || 'Listening...'}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Floating arrow-key pad — fixed to the page, tracks the visual
              viewport so it rides up above the virtual keyboard. */}
          <div
            className="fixed left-2 z-[45] grid grid-cols-3 grid-rows-3 gap-1 pointer-events-none"
            style={{ bottom: keyPadBottom }}
          >
            <div />
            <FloatingKeyButton label="Up arrow" onPress={() => sendKey('\x1b[A')}>
              <ArrowUp className="w-4 h-4" />
            </FloatingKeyButton>
            <div />
            <FloatingKeyButton label="Left arrow" onPress={() => sendKey('\x1b[D')}>
              <ArrowLeft className="w-4 h-4" />
            </FloatingKeyButton>
            <div />
            <FloatingKeyButton label="Right arrow" onPress={() => sendKey('\x1b[C')}>
              <ArrowRight className="w-4 h-4" />
            </FloatingKeyButton>
            <div />
            <FloatingKeyButton label="Down arrow" onPress={() => sendKey('\x1b[B')}>
              <ArrowDown className="w-4 h-4" />
            </FloatingKeyButton>
            <div />
          </div>

          <div
            className="fixed left-2 z-[45] pointer-events-none"
            style={{ bottom: keyPadBottom + EXTRA_LEFT_KEY_OFFSET_PX }}
          >
            <FloatingKeyButton label="Tab" onPress={() => sendKey('\t')}>
              <span className="text-[11px] font-mono font-semibold">Tab</span>
            </FloatingKeyButton>
          </div>

          {/* Floating Enter key — fixed to the page, right side */}
          <div className="fixed right-2 z-[45] pointer-events-none" style={{ bottom: keyPadBottom }}>
            <FloatingKeyButton label="Enter" onPress={() => sendKey('\r')}>
              <CornerDownLeft className="w-4 h-4" />
            </FloatingKeyButton>
          </div>

          {/* Floating interrupt (Ctrl+C) key — set well above Enter so a thumb
              reaching for Enter can't graze it and kill the running command. */}
          <div
            className="fixed right-2 z-[45] pointer-events-none"
            style={{ bottom: keyPadBottom + INTERRUPT_KEY_OFFSET_PX }}
          >
            <FloatingKeyButton label="Interrupt (Ctrl+C)" onPress={() => sendKey('\x03')}>
              <span className="text-xs font-mono font-semibold">^C</span>
            </FloatingKeyButton>
          </div>

          <div
            className="fixed right-2 z-[45] pointer-events-none"
            style={{ bottom: keyPadBottom + EXTRA_RIGHT_KEY_OFFSET_PX }}
          >
            <FloatingKeyButton label="Escape" onPress={() => sendKey('\x1b')}>
              <span className="text-[11px] font-mono font-semibold">Esc</span>
            </FloatingKeyButton>
          </div>
        </>,
        document.body
      )}
      {pendingCloseId && createPortal(
        <CloseTerminalDialog
          title={terminalIdToTitle[pendingCloseId] || pendingCloseId}
          onCancel={cancelCloseTerminal}
          onConfirm={confirmCloseTerminal}
        />,
        document.body
      )}

    </div>
  )
}

function FloatingKeyButton({
  label,
  onPress,
  children,
}: {
  label: string
  onPress: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onPointerDown={(e) => {
        e.preventDefault()
        onPress()
      }}
      className="pointer-events-auto w-8 h-8 flex items-center justify-center rounded-full shadow-lg border opacity-60 active:opacity-100 app-panel-strong"
    >
      {children}
    </button>
  )
}
