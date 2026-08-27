import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { isInputEventLoggingEnabled, logInputEvent } from '../../debug/input-event-logger.js'
import { terminalSocket } from '../../ws/terminal-socket.js'
import { useThemeStore } from '../../stores/theme.store.js'
import { openTerminalWebUrl } from './terminal-links.js'
import { getCommittedImeInputText } from './ime-input.js'
import {
  createVoiceInputState,
  getVoiceCommitText,
  getVoiceDeletionCount,
  getVoiceDraftText,
  isVoiceTextData,
  reconcileVoiceInputText,
  stageVoiceDeletion,
  stageVoiceFinalText,
  stageVoiceText,
  type VoiceInputState,
} from './voice-input-state.js'

type Props = {
  terminalId: string
  fontSize?: number
  voiceInputMode?: boolean
  onActionsChange?: (actions: TerminalViewActions | null) => void
  onVoiceDraftChange?: (draft: string) => void
}

type RecentInputTextChunk = {
  data: string
  timestamp: number
}

export type TerminalViewActions = {
  copySelection: () => void
  focus: () => void
  sendInput: (data: string) => void
  scrollLines: (delta: number) => void
}

const IME_ECHO_SUPPRESSION_MS = 500
const RECENT_XTERM_DATA_WINDOW_MS = 120
const RECENT_INPUT_TEXT_WINDOW_MS = 3000
const MAX_RECENT_INPUT_TEXT_LENGTH = 300
const MAX_OUTPUT_CHARS_PER_FRAME = 64 * 1024
const TOUCH_TAP_MOVE_THRESHOLD_PX = 8
const USER_SCROLL_IDLE_MS = 150
const VOICE_FINALIZATION_IDLE_MS = 1200
const VOICE_INPUT_DRAIN_MS = 1800
const MIN_ATTACH_COLS = 20
const MIN_ATTACH_ROWS = 5
const MIN_FIT_WIDTH_PX = 120
const MIN_FIT_HEIGHT_PX = 80

type TerminalGeometry = {
  cols: number
  rows: number
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result)
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'))
    reader.readAsDataURL(file)
  })
}

function getClipboardImageFile(event: ClipboardEvent): File | null {
  const files = Array.from(event.clipboardData?.files ?? [])
  const file = files.find((item) => item.type.startsWith('image/'))
  if (file) return file

  const items = Array.from(event.clipboardData?.items ?? [])
  const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'))
  return imageItem?.getAsFile() ?? null
}

function copyText(text: string): boolean {
  if (!text) return false

  const copiedWithFallback = fallbackCopyText(text)
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => undefined)
  }

  return copiedWithFallback || Boolean(navigator.clipboard?.writeText)
}

function fallbackCopyText(text: string): boolean {
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)
  return copied
}

function consumePendingImeEcho(data: string, pending: string): string | null {
  if (!pending) return null

  if (pending.startsWith(data)) {
    return pending.slice(data.length)
  }

  if (data.startsWith(pending)) {
    return ''
  }

  if (pending.includes(data)) {
    return pending
  }

  return null
}

function getComposedText(textarea: HTMLTextAreaElement, startValue: string, fallback: string): string {
  if (textarea.value.startsWith(startValue)) {
    return textarea.value.slice(startValue.length)
  }

  return fallback
}

function containsCommittedCjkText(data: string): boolean {
  return /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(data)
}

function getCodePoints(value: string | null | undefined): string[] {
  if (!value) return []

  return Array.from(value).map((char) => `U+${char.codePointAt(0)?.toString(16).toUpperCase().padStart(4, '0')}`)
}

function getCharacterLength(value: string): number {
  return Array.from(value).length
}

function shouldUseNativeTouchScrollLayer(): boolean {
  return window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window
}

function createNativeTouchScrollLayer(container: HTMLElement, term: Terminal) {
  if (!shouldUseNativeTouchScrollLayer()) {
    return {
      refresh: () => undefined,
      dispose: () => undefined,
    }
  }

  const overlay = document.createElement('div')
  const spacer = document.createElement('div')
  let syncFrameId: number | null = null
  let tapStart: { x: number; y: number } | null = null
  let tapMoved = false
  let touchActive = false
  let lastUserScrollAt = 0
  let programmaticScrollTop: number | null = null
  let idleRefreshTimeout: ReturnType<typeof setTimeout> | null = null

  // Writing scrollTop on a scrolling element cancels the browser's momentum
  // fling, so viewport→overlay sync must never run while the user's gesture
  // (touch or its inertia tail) owns the overlay.
  const isUserScrolling = () =>
    touchActive || performance.now() - lastUserScrollAt < USER_SCROLL_IDLE_MS

  // Programmatic viewport moves that land mid-gesture are skipped by refresh,
  // and nothing fires once the gesture goes quiet — reconcile on a trailing
  // timer instead.
  const scheduleIdleRefresh = () => {
    if (idleRefreshTimeout != null) clearTimeout(idleRefreshTimeout)
    idleRefreshTimeout = setTimeout(() => {
      idleRefreshTimeout = null
      refresh()
    }, USER_SCROLL_IDLE_MS + 50)
  }

  overlay.className = 'xterm-native-touch-scroll'
  overlay.setAttribute('aria-hidden', 'true')
  overlay.style.position = 'absolute'
  overlay.style.inset = '0'
  overlay.style.zIndex = '4'
  overlay.style.overflowX = 'hidden'
  overlay.style.overflowY = 'auto'
  overlay.style.background = 'transparent'
  overlay.style.touchAction = 'pan-y'
  overlay.style.overscrollBehavior = 'contain'
  ;(overlay.style as CSSStyleDeclaration & { WebkitOverflowScrolling?: string }).WebkitOverflowScrolling = 'touch'

  spacer.style.width = '1px'
  overlay.appendChild(spacer)
  container.appendChild(overlay)

  const getViewport = () => term.element?.querySelector('.xterm-viewport') as HTMLElement | null

  const refresh = () => {
    if (syncFrameId != null) return

    syncFrameId = requestAnimationFrame(() => {
      syncFrameId = null
      const viewport = getViewport()
      if (!viewport || term.buffer.active !== term.buffer.normal) {
        overlay.style.display = 'none'
        return
      }

      overlay.style.display = viewport.scrollHeight > viewport.clientHeight ? 'block' : 'none'
      overlay.style.height = `${viewport.clientHeight}px`
      spacer.style.height = `${viewport.scrollHeight}px`
      if (!isUserScrolling() && Math.abs(overlay.scrollTop - viewport.scrollTop) > 1) {
        programmaticScrollTop = viewport.scrollTop
        overlay.scrollTop = viewport.scrollTop
      }
    })
  }

  const handleOverlayScroll = () => {
    if (programmaticScrollTop != null && Math.abs(overlay.scrollTop - programmaticScrollTop) <= 1) {
      programmaticScrollTop = null
      return
    }
    programmaticScrollTop = null
    lastUserScrollAt = performance.now()
    scheduleIdleRefresh()

    const viewport = getViewport()
    if (!viewport || term.buffer.active !== term.buffer.normal) return
    if (Math.abs(viewport.scrollTop - overlay.scrollTop) > 0.5) {
      viewport.scrollTop = overlay.scrollTop
    }
  }

  const handleTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0]
    tapStart = touch ? { x: touch.clientX, y: touch.clientY } : null
    tapMoved = false
    touchActive = true
  }

  const handleTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0]
    if (!touch || !tapStart) return
    if (
      Math.abs(touch.clientX - tapStart.x) > TOUCH_TAP_MOVE_THRESHOLD_PX ||
      Math.abs(touch.clientY - tapStart.y) > TOUCH_TAP_MOVE_THRESHOLD_PX
    ) {
      tapMoved = true
    }
  }

  const handleTouchEnd = (event: TouchEvent) => {
    if (!tapMoved) {
      // Suppress the browser's synthetic mouse events for this tap. They fire
      // ~300ms later on whatever sits at the same coordinates (this overlay,
      // or — after the keyboard resize shifts layout — some other element),
      // and a mousedown on a non-focusable element blurs the xterm textarea,
      // which instantly dismisses the virtual keyboard we just opened.
      if (event.cancelable) {
        event.preventDefault()
      }
      term.focus()
    }
    tapStart = null
    tapMoved = false
    touchActive = false
    lastUserScrollAt = performance.now()
    scheduleIdleRefresh()
  }

  // Backstop for any mousedown that still reaches the overlay (stray synthetic
  // events, touch-capable laptops): keep it from stealing focus.
  const handleMouseDown = (event: MouseEvent) => {
    event.preventDefault()
  }

  overlay.addEventListener('scroll', handleOverlayScroll, { passive: true })
  overlay.addEventListener('touchstart', handleTouchStart, { passive: true })
  overlay.addEventListener('touchmove', handleTouchMove, { passive: true })
  overlay.addEventListener('touchend', handleTouchEnd)
  overlay.addEventListener('touchcancel', handleTouchEnd)
  overlay.addEventListener('mousedown', handleMouseDown)
  refresh()

  return {
    refresh,
    dispose: () => {
      if (syncFrameId != null) {
        cancelAnimationFrame(syncFrameId)
      }
      if (idleRefreshTimeout != null) {
        clearTimeout(idleRefreshTimeout)
      }
      overlay.removeEventListener('scroll', handleOverlayScroll)
      overlay.removeEventListener('touchstart', handleTouchStart)
      overlay.removeEventListener('touchmove', handleTouchMove)
      overlay.removeEventListener('touchend', handleTouchEnd)
      overlay.removeEventListener('touchcancel', handleTouchEnd)
      overlay.removeEventListener('mousedown', handleMouseDown)
      overlay.remove()
    },
  }
}

function countSuffixChunks(chunks: RecentInputTextChunk[], data: string): number {
  const recentText = chunks.map((chunk) => chunk.data).join('')
  if (!recentText.endsWith(data)) return 0

  const suffixStart = recentText.length - data.length
  let offset = 0
  let count = 0

  for (const chunk of chunks) {
    const chunkEnd = offset + chunk.data.length
    if (chunkEnd > suffixStart && offset < recentText.length) {
      count += 1
    }
    offset = chunkEnd
  }

  return count
}

function describeElement(element: EventTarget | Element | null | undefined): string | undefined {
  if (!(element instanceof Element)) return undefined

  const id = element.id ? `#${element.id}` : ''
  const classes = Array.from(element.classList).map((className) => `.${className}`).join('')
  return `${element.tagName.toLowerCase()}${id}${classes}`
}

export function XtermView({
  terminalId,
  fontSize = 14,
  voiceInputMode = false,
  onActionsChange,
  onVoiceDraftChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const actionsRef = useRef<TerminalViewActions | null>(null)
  const onActionsChangeRef = useRef(onActionsChange)
  const atBottomRef = useRef(true)
  const isComposingRef = useRef(false)
  const compositionStartValueRef = useRef('')
  const compositionTextRef = useRef('')
  const imeEchoDataRef = useRef('')
  const imeEchoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const compositionEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recentXtermDataRef = useRef('')
  const recentXtermDataTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const recentInputTextChunksRef = useRef<RecentInputTextChunk[]>([])
  const recentInputTextTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [voiceDraft, setVoiceDraft] = useState('')
  const voiceStateRef = useRef<VoiceInputState>(createVoiceInputState())
  const voiceFinalizationTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceDrainTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voiceInputDrainingRef = useRef(false)
  const startVoiceInputRef = useRef<(() => void) | null>(null)
  const stopVoiceInputRef = useRef<(() => void) | null>(null)
  const voiceInputModeRef = useRef(voiceInputMode)
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme)

  useEffect(() => {
    onVoiceDraftChange?.(voiceDraft)
  }, [onVoiceDraftChange, voiceDraft])

  useEffect(() => {
    return () => onVoiceDraftChange?.('')
  }, [onVoiceDraftChange])

  useEffect(() => {
    const wasVoiceInputMode = voiceInputModeRef.current
    voiceInputModeRef.current = voiceInputMode
    if (voiceInputMode) {
      if (!wasVoiceInputMode) startVoiceInputRef.current?.()
      return
    }

    if (wasVoiceInputMode) {
      if (stopVoiceInputRef.current) {
        stopVoiceInputRef.current()
      } else {
        if (voiceFinalizationTimeoutRef.current) {
          clearTimeout(voiceFinalizationTimeoutRef.current)
          voiceFinalizationTimeoutRef.current = null
        }
        voiceStateRef.current = createVoiceInputState()
        setVoiceDraft('')
      }
    } else if (!voiceInputDrainingRef.current) {
      voiceStateRef.current = createVoiceInputState()
      setVoiceDraft('')
    }
  }, [voiceInputMode])

  useEffect(() => {
    onActionsChangeRef.current = onActionsChange
    onActionsChange?.(actionsRef.current)

    return () => {
      onActionsChange?.(null)
      if (onActionsChangeRef.current === onActionsChange) {
        onActionsChangeRef.current = undefined
      }
    }
  }, [onActionsChange])

  useEffect(() => {
    if (!containerRef.current) return

    const theme =
      resolvedTheme === 'dark'
        ? {
            background: '#090b0f',
            foreground: '#edf2f7',
            cursor: '#93c5fd',
            selectionBackground: '#2563eb',
            selectionForeground: '#ffffff',
            selectionInactiveBackground: '#1d4ed8',
          }
        : {
            background: '#f7f9fc',
            foreground: '#162031',
            cursor: '#2563eb',
            selectionBackground: '#93c5fd',
            selectionForeground: '#08111f',
            selectionInactiveBackground: '#bfdbfe',
          }

    const term = new Terminal({
      cursorBlink: true,
      fontSize,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      theme,
      scrollback: 10000,
      linkHandler: {
        activate: (_event, uri) => openTerminalWebUrl(uri),
      },
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon((_event, uri) => openTerminalWebUrl(uri))

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)
    term.open(containerRef.current)
    const container = containerRef.current

    // TUIs like Claude Code enable mouse reporting, which makes xterm.js send
    // drags to the app instead of selecting text (breaking copy). Force
    // left-button drags to keep selecting locally; other buttons and wheel
    // events still reach the app. Uses a private xterm.js API (no public one).
    const xtermCore = (
      term as unknown as {
        _core?: {
          _selectionService?: {
            shouldForceSelection(event: MouseEvent): boolean
            disable(): void
          }
          coreService?: { triggerDataEvent(data: string, wasUserInput?: boolean): void }
          coreMouseService?: { triggerMouseEvent(event: unknown): boolean }
        }
      }
    )._core
    const selectionService = xtermCore?._selectionService
    if (selectionService) {
      const shouldForceSelection = selectionService.shouldForceSelection.bind(selectionService)
      selectionService.shouldForceSelection = (event) => event.button === 0 || shouldForceSelection(event)
      // Apps re-assert mouse-tracking modes on every render, and each DECSET
      // calls disable() -> clearSelection(), wiping the selection right after
      // mouseup. Selection is forced above, so keep the service enabled.
      selectionService.disable = () => {}
    }
    // Mouse reports (motion/wheel forwarded to the app) are sent as "user
    // input", which SelectionService listens to and clears the selection on —
    // so moving the mouse over a TUI with any-motion tracking wipes it.
    // Unflag mouse reports as user input; keystrokes still clear as usual.
    const coreService = xtermCore?.coreService
    const coreMouseService = xtermCore?.coreMouseService
    if (coreService && coreMouseService) {
      const triggerDataEvent = coreService.triggerDataEvent.bind(coreService)
      const triggerMouseEvent = coreMouseService.triggerMouseEvent.bind(coreMouseService)
      let inMouseReport = false
      coreService.triggerDataEvent = (data, wasUserInput) => {
        triggerDataEvent(data, wasUserInput && !inMouseReport)
      }
      coreMouseService.triggerMouseEvent = (event) => {
        inMouseReport = true
        try {
          return triggerMouseEvent(event)
        } finally {
          inMouseReport = false
        }
      }
    }
    const nativeTouchScrollLayer = createNativeTouchScrollLayer(container, term)
    const sendScroll = (up: boolean, lines: number) => {
      term.scrollLines(up ? -lines : lines)
      const buf = term.buffer.active
      atBottomRef.current = buf.viewportY >= buf.baseY
      nativeTouchScrollLayer.refresh()
    }

    let mouseSelectionStart: { x: number; y: number } | null = null
    let mouseSelectionMoved = false
    let cachedSelectionText = ''
    let cachedSelectionTimeoutId: ReturnType<typeof setTimeout> | null = null

    const clearCachedSelectionLater = () => {
      if (cachedSelectionTimeoutId) {
        clearTimeout(cachedSelectionTimeoutId)
      }
      cachedSelectionTimeoutId = setTimeout(() => {
        cachedSelectionText = ''
        cachedSelectionTimeoutId = null
      }, 8000)
    }

    const rememberSelectionText = (text: string) => {
      if (!text.trim()) return
      cachedSelectionText = text
      clearCachedSelectionLater()
    }

    const getNativeSelectionText = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return ''

      const range = selection.getRangeAt(0)
      const ancestor = range.commonAncestorContainer
      const element = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement
      if (!(element instanceof Element) || !container.contains(element)) return ''

      return selection.toString()
    }

    const getTerminalSelectionText = () => term.getSelection() || getNativeSelectionText() || cachedSelectionText

    const updateCachedSelectionText = () => {
      rememberSelectionText(term.getSelection() || getNativeSelectionText())
    }

    const handleMouseDownForCopy = (event: MouseEvent) => {
      if (event.button !== 0) {
        mouseSelectionStart = null
        mouseSelectionMoved = false
        return
      }

      mouseSelectionStart = { x: event.clientX, y: event.clientY }
      mouseSelectionMoved = false
    }

    const handleMouseMoveForCopy = (event: MouseEvent) => {
      if (!mouseSelectionStart) return
      const dx = Math.abs(event.clientX - mouseSelectionStart.x)
      const dy = Math.abs(event.clientY - mouseSelectionStart.y)
      if (dx > 3 || dy > 3) {
        mouseSelectionMoved = true
      }
      updateCachedSelectionText()
    }

    const handleMouseUpForCopy = (event: MouseEvent) => {
      if (event.button !== 0 || !mouseSelectionStart) return

      if (mouseSelectionMoved) {
        updateCachedSelectionText()
      }

      mouseSelectionStart = null
      mouseSelectionMoved = false
    }

    container.addEventListener('mousedown', handleMouseDownForCopy, true)
    container.addEventListener('mousemove', handleMouseMoveForCopy, true)
    container.addEventListener('mouseup', handleMouseUpForCopy, true)
    document.addEventListener('selectionchange', updateCachedSelectionText)

    const scrollToBottom = () => {
      term.scrollToBottom()
      atBottomRef.current = true
      nativeTouchScrollLayer.refresh()
    }

    const fitAndReadGeometry = (): TerminalGeometry | null => {
      const rect = container.getBoundingClientRect()
      if (rect.width < MIN_FIT_WIDTH_PX || rect.height < MIN_FIT_HEIGHT_PX) {
        return null
      }

      fitAddon.fit()
      if (term.cols < MIN_ATTACH_COLS || term.rows < MIN_ATTACH_ROWS) {
        return null
      }

      return { cols: term.cols, rows: term.rows }
    }

    let terminalAttached = false
    const attachTerminal = (): boolean => {
      const geometry = fitAndReadGeometry()
      if (!geometry) return false

      terminalAttached = true
      terminalSocket.attach({
        terminalId,
        ...geometry,
      })
      return true
    }

    let resizeFrameId: number | null = null
    let scrollAfterResize = false

    const fitResizeAndMaybeScroll = (forceScroll = false) => {
      scrollAfterResize = scrollAfterResize || forceScroll || atBottomRef.current
      if (resizeFrameId != null) return

      resizeFrameId = requestAnimationFrame(() => {
        resizeFrameId = null
        const shouldScroll = scrollAfterResize
        scrollAfterResize = false

        const geometry = fitAndReadGeometry()
        if (!geometry) {
          return
        }

        if (terminalAttached) {
          terminalSocket.resize({
            terminalId,
            ...geometry,
          })
        } else {
          terminalAttached = true
          terminalSocket.attach({
            terminalId,
            ...geometry,
          })
        }

        if (shouldScroll) {
          requestAnimationFrame(scrollToBottom)
        }
        nativeTouchScrollLayer.refresh()
      })
    }

    term.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLowerCase()
      const isCopyShortcut =
        event.type === 'keydown' &&
        key === 'c' &&
        ((event.ctrlKey && event.shiftKey && !event.altKey) ||
          (event.altKey && !event.ctrlKey && !event.metaKey))

      if (!isCopyShortcut) {
        return true
      }

      event.preventDefault()
      event.stopPropagation()
      copyText(getTerminalSelectionText())
      return false
    })

    let initialAttachFrameId: number | null = requestAnimationFrame(() => {
      initialAttachFrameId = null
      if (attachTerminal()) {
        requestAnimationFrame(scrollToBottom)
      }
    })

    const textarea = term.textarea
    if (!textarea) {
      return
    }
    // xterm uses a hidden textarea for input. Mark it as terminal input so
    // mobile browsers and password managers do not offer form autofill.
    textarea.name = 'terminal-input'
    // WebKit may ignore "off" for fields it has already classified as a
    // form input. one-time-code keeps the keyboard from offering contacts,
    // payment cards, and saved credentials for terminal input.
    textarea.autocomplete = 'one-time-code'
    textarea.autocapitalize = 'off'
    textarea.setAttribute('autocorrect', 'off')
    textarea.spellcheck = false
    textarea.setAttribute('inputmode', 'text')
    textarea.setAttribute('autofill', 'off')
    textarea.setAttribute('data-form-type', 'other')
    textarea.setAttribute('data-1p-ignore', 'true')
    textarea.setAttribute('data-lpignore', 'true')
    textarea.setAttribute('data-bwignore', 'true')
    const debugInputEventsEnabled = isInputEventLoggingEnabled()

    const clearImeEchoData = () => {
      imeEchoDataRef.current = ''
      if (imeEchoTimeoutRef.current) {
        clearTimeout(imeEchoTimeoutRef.current)
        imeEchoTimeoutRef.current = null
      }
    }

    const suppressImeEchoData = (data: string) => {
      imeEchoDataRef.current = data
      if (imeEchoTimeoutRef.current) {
        clearTimeout(imeEchoTimeoutRef.current)
      }
      imeEchoTimeoutRef.current = setTimeout(clearImeEchoData, IME_ECHO_SUPPRESSION_MS)
    }

    const clearRecentXtermData = () => {
      recentXtermDataRef.current = ''
      if (recentXtermDataTimeoutRef.current) {
        clearTimeout(recentXtermDataTimeoutRef.current)
        recentXtermDataTimeoutRef.current = null
      }
    }

    const rememberRecentXtermData = (data: string) => {
      recentXtermDataRef.current += data
      if (recentXtermDataTimeoutRef.current) {
        clearTimeout(recentXtermDataTimeoutRef.current)
      }
      recentXtermDataTimeoutRef.current = setTimeout(clearRecentXtermData, RECENT_XTERM_DATA_WINDOW_MS)
    }

    const consumeRecentXtermData = (data: string): boolean => {
      const remaining = consumePendingImeEcho(data, recentXtermDataRef.current)
      if (remaining == null) return false
      recentXtermDataRef.current = remaining
      return true
    }

    const consumeRecentVoiceXtermText = (data: string): string | null => {
      const pendingText = recentXtermDataRef.current
      if (!pendingText) return null

      const reconciled = reconcileVoiceInputText(pendingText, data)
      recentXtermDataRef.current = reconciled.remainingXtermText
      return reconciled.remainingInputText
    }

    const clearRecentInputText = () => {
      recentInputTextChunksRef.current = []
      if (recentInputTextTimeoutRef.current) {
        clearTimeout(recentInputTextTimeoutRef.current)
        recentInputTextTimeoutRef.current = null
      }
    }

    const pruneRecentInputText = () => {
      const cutoff = Date.now() - RECENT_INPUT_TEXT_WINDOW_MS
      const freshChunks = recentInputTextChunksRef.current.filter((chunk) => chunk.timestamp >= cutoff && chunk.data)
      const trimmedChunks: RecentInputTextChunk[] = []
      let remainingLength = MAX_RECENT_INPUT_TEXT_LENGTH

      for (let index = freshChunks.length - 1; index >= 0 && remainingLength > 0; index -= 1) {
        const chunk = freshChunks[index]
        const chars = Array.from(chunk.data)
        const data =
          chars.length > remainingLength
            ? chars.slice(chars.length - remainingLength).join('')
            : chunk.data

        trimmedChunks.unshift({
          data,
          timestamp: chunk.timestamp,
        })
        remainingLength -= Math.min(chars.length, remainingLength)
      }

      recentInputTextChunksRef.current = trimmedChunks
    }

    const rememberInputText = (data: string) => {
      if (!containsCommittedCjkText(data)) return

      pruneRecentInputText()
      recentInputTextChunksRef.current.push({
        data,
        timestamp: Date.now(),
      })
      pruneRecentInputText()

      if (recentInputTextTimeoutRef.current) {
        clearTimeout(recentInputTextTimeoutRef.current)
      }
      recentInputTextTimeoutRef.current = setTimeout(clearRecentInputText, RECENT_INPUT_TEXT_WINDOW_MS)
    }

    const getReplayedInputTextReason = (data: string): string | null => {
      if (!data || !containsCommittedCjkText(data)) return null

      pruneRecentInputText()
      const chunks = recentInputTextChunksRef.current
      if (!chunks.length) return null

      const suffixChunkCount = countSuffixChunks(chunks, data)
      if (suffixChunkCount > 1) {
        return `recent-suffix-spans-${suffixChunkCount}-chunks`
      }

      const lastChunk = chunks.at(-1)
      if (
        lastChunk &&
        getCharacterLength(data) >= 4 &&
        getCharacterLength(data) > getCharacterLength(lastChunk.data) &&
        chunks.map((chunk) => chunk.data).join('').endsWith(data)
      ) {
        return 'recent-suffix-larger-than-last-chunk'
      }

      return null
    }

    const getDebugState = () => ({
      isComposing: isComposingRef.current,
      compositionStartValue: compositionStartValueRef.current,
      compositionText: compositionTextRef.current,
      imeEchoData: imeEchoDataRef.current,
      recentInputText: recentInputTextChunksRef.current.map((chunk) => chunk.data).join(''),
      voiceInputMode: voiceInputModeRef.current,
      voiceInputDraining: voiceInputDrainingRef.current,
      voicePhase: voiceStateRef.current.phase,
      voiceDraft: getVoiceDraftText(voiceStateRef.current),
      voiceInterimText: voiceStateRef.current.interimText,
      voiceFinalText: voiceStateRef.current.finalText,
      voiceDeletionCount: voiceStateRef.current.deletionCount,
    })

    const logEvent = (source: string, event: Event) => {
      if (!debugInputEventsEnabled) return

      const inputEvent = event instanceof InputEvent ? event : null
      const keyboardEvent = event instanceof KeyboardEvent ? event : null
      const compositionEvent = event instanceof CompositionEvent ? event : null
      const clipboardEvent = event instanceof ClipboardEvent ? event : null
      const data = inputEvent?.data ?? compositionEvent?.data ?? clipboardEvent?.clipboardData?.getData('text/plain') ?? null

      logInputEvent({
        terminalId,
        source,
        type: event.type,
        phase: event.eventPhase === Event.CAPTURING_PHASE ? 'capture' : event.eventPhase === Event.BUBBLING_PHASE ? 'bubble' : 'target',
        target: describeElement(event.target),
        activeElement: describeElement(document.activeElement),
        timeStamp: event.timeStamp,
        value: textarea.value,
        valueLength: textarea.value.length,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        data,
        dataCodePoints: getCodePoints(data),
        inputType: inputEvent?.inputType,
        isComposing: inputEvent?.isComposing ?? keyboardEvent?.isComposing,
        key: keyboardEvent?.key,
        code: keyboardEvent?.code,
        keyCode: keyboardEvent?.keyCode,
        which: keyboardEvent?.which,
        charCode: keyboardEvent?.charCode,
        repeat: keyboardEvent?.repeat,
        ctrlKey: keyboardEvent?.ctrlKey,
        altKey: keyboardEvent?.altKey,
        shiftKey: keyboardEvent?.shiftKey,
        metaKey: keyboardEvent?.metaKey,
        bubbles: event.bubbles,
        cancelable: event.cancelable,
        composed: event.composed,
        defaultPrevented: event.defaultPrevented,
        appState: getDebugState(),
      })
    }

    const logAppData = (source: string, data: string) => {
      if (!debugInputEventsEnabled) return

      logInputEvent({
        terminalId,
        source,
        type: 'app-data',
        target: 'terminal',
        activeElement: describeElement(document.activeElement),
        value: textarea.value,
        valueLength: textarea.value.length,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        data,
        dataCodePoints: getCodePoints(data),
        appState: getDebugState(),
      })
    }

    const clearVoiceFinalizationTimer = () => {
      if (voiceFinalizationTimeoutRef.current) {
        clearTimeout(voiceFinalizationTimeoutRef.current)
        voiceFinalizationTimeoutRef.current = null
      }
    }

    const clearVoiceDrainTimer = () => {
      if (voiceDrainTimeoutRef.current) {
        clearTimeout(voiceDrainTimeoutRef.current)
        voiceDrainTimeoutRef.current = null
      }
    }

    const isVoiceCaptureActive = () =>
      shouldUseNativeTouchScrollLayer() &&
      (voiceInputModeRef.current || voiceInputDrainingRef.current)

    const syncVoiceDraft = () => {
      setVoiceDraft(getVoiceDraftText(voiceStateRef.current))
    }

    const resetVoiceDraft = () => {
      clearVoiceFinalizationTimer()
      voiceStateRef.current = createVoiceInputState()
      setVoiceDraft('')
    }

    const commitVoiceDraft = (suffix = '') => {
      const text = getVoiceCommitText(voiceStateRef.current)
      resetVoiceDraft()

      if (!voiceInputModeRef.current && voiceInputDrainingRef.current) {
        clearVoiceDrainTimer()
        voiceInputDrainingRef.current = false
      }

      const data = text + suffix
      if (!data) return

      logAppData('app.commitVoiceInput', data)
      terminalSocket.input({ terminalId, data })
      rememberInputText(text)
    }

    const scheduleVoiceFinalization = () => {
      clearVoiceFinalizationTimer()
      voiceFinalizationTimeoutRef.current = setTimeout(() => {
        voiceFinalizationTimeoutRef.current = null
        const state = voiceStateRef.current
        if (!isVoiceCaptureActive() || state.phase !== 'finalizing' || !state.finalText) return

        logAppData('app.voiceFinalizationTimeout', state.finalText)
        commitVoiceDraft()
      }, VOICE_FINALIZATION_IDLE_MS)
    }

    const stageVoiceTextData = (data: string) => {
      voiceStateRef.current = stageVoiceText(voiceStateRef.current, data)
      syncVoiceDraft()
      logAppData('app.stageVoiceText', data)

      if (voiceStateRef.current.phase === 'finalizing') {
        scheduleVoiceFinalization()
      } else {
        clearVoiceFinalizationTimer()
      }
    }

    const stageVoiceFinalTextData = (data: string) => {
      voiceStateRef.current = stageVoiceFinalText(voiceStateRef.current, data)
      syncVoiceDraft()
      logAppData('app.stageVoiceFinalText', data)
      scheduleVoiceFinalization()
    }

    const stageVoiceDeletionData = (data: string) => {
      const deletionCount = getVoiceDeletionCount(data)
      if (!deletionCount || voiceStateRef.current.phase === 'idle') return false

      clearVoiceFinalizationTimer()
      clearRecentXtermData()
      for (let index = 0; index < deletionCount; index += 1) {
        voiceStateRef.current = stageVoiceDeletion(voiceStateRef.current).state
      }
      syncVoiceDraft()
      logAppData('app.stageVoiceDeletion', data)
      return true
    }

    const consumeVoiceData = (data: string): boolean => {
      if (!isVoiceCaptureActive()) return false

      if (stageVoiceDeletionData(data)) return true
      if (isVoiceTextData(data)) {
        stageVoiceTextData(data)
        return true
      }
      if (data === '\r' || data === '\n') {
        commitVoiceDraft(data)
        return true
      }
      if (data === '\x1b' || data === '\x03') {
        resetVoiceDraft()
        return false
      }

      // Commit staged text before forwarding any other control sequence so a
      // toolbar/keyboard command cannot overtake the voice draft.
      if (getVoiceCommitText(voiceStateRef.current)) {
        commitVoiceDraft()
      }
      return false
    }

    const forwardTerminalData = (data: string) => {
      if (consumeVoiceData(data)) {
        // xterm normally emits before our textarea input listener. Remember
        // direct text so that listener can distinguish an echo from the iOS
        // cases where xterm emits nothing and input must be the fallback.
        if (isVoiceTextData(data)) rememberRecentXtermData(data)
        return
      }

      rememberRecentXtermData(data)
      logAppData('app.terminalSocket.input', data)
      terminalSocket.input({ terminalId, data })
      rememberInputText(data)
    }

    startVoiceInputRef.current = () => {
      clearVoiceDrainTimer()
      clearRecentXtermData()
      voiceInputDrainingRef.current = false
      resetVoiceDraft()
    }
    stopVoiceInputRef.current = () => {
      if (voiceStateRef.current.phase === 'idle' && !isComposingRef.current) {
        voiceInputDrainingRef.current = false
        resetVoiceDraft()
        return
      }

      voiceInputDrainingRef.current = true
      clearVoiceDrainTimer()
      voiceDrainTimeoutRef.current = setTimeout(() => {
        voiceDrainTimeoutRef.current = null
        voiceInputDrainingRef.current = false
        if (voiceStateRef.current.phase === 'finalizing' && voiceStateRef.current.finalText) {
          commitVoiceDraft()
        } else {
          resetVoiceDraft()
        }
      }, VOICE_INPUT_DRAIN_MS)
    }

    const sendCommittedImeText = (data: string) => {
      if (!data) return

      if (compositionEndTimeoutRef.current) {
        clearTimeout(compositionEndTimeoutRef.current)
        compositionEndTimeoutRef.current = null
      }

      if (isVoiceCaptureActive()) {
        stageVoiceFinalTextData(data)
        suppressImeEchoData(data)
      } else {
        logAppData('app.sendCommittedImeText', data)
        terminalSocket.input({ terminalId, data })
        rememberInputText(data)
        suppressImeEchoData(data)
      }
      compositionStartValueRef.current = textarea.value
      compositionTextRef.current = ''
      isComposingRef.current = false
    }

    const sendInputEventText = (data: string) => {
      if (!data || consumeRecentXtermData(data)) return

      const replayReason = getReplayedInputTextReason(data)
      if (replayReason) {
        logInputEvent({
          terminalId,
          source: 'app.inputEventText',
          type: 'replay-suppressed',
          target: 'terminal',
          activeElement: describeElement(document.activeElement),
          value: textarea.value,
          valueLength: textarea.value.length,
          selectionStart: textarea.selectionStart,
          selectionEnd: textarea.selectionEnd,
          data,
          dataCodePoints: getCodePoints(data),
          appState: {
            ...getDebugState(),
            replayReason,
          },
        })
        suppressImeEchoData(data)
        return
      }

      logAppData('app.inputEventText', data)
      terminalSocket.input({ terminalId, data })
      rememberInputText(data)
      suppressImeEchoData(data)
    }

    const handleBeforeInput = (event: Event) => {
      logEvent('textarea', event)
      const inputEvent = event as InputEvent

      // xterm.onData is the canonical source for direct mobile voice input.
      // Observing beforeinput here as well used to count every deletion twice.
      if (
        isVoiceCaptureActive() &&
        !inputEvent.isComposing &&
        inputEvent.inputType !== 'insertCompositionText'
      ) {
        return
      }

      if (
        !isComposingRef.current &&
        (inputEvent.isComposing || inputEvent.inputType === 'insertCompositionText')
      ) {
        isComposingRef.current = true
        compositionStartValueRef.current = textarea.value
        compositionTextRef.current = ''
        clearImeEchoData()
        clearRecentInputText()
        return
      }

      if (!isComposingRef.current && inputEvent.inputType === 'insertText' && inputEvent.data) {
        const replayReason = getReplayedInputTextReason(inputEvent.data)
        if (replayReason) {
          logInputEvent({
            terminalId,
            source: 'app.inputEventText',
            type: 'replay-beforeinput-prevented',
            target: describeElement(textarea),
            activeElement: describeElement(document.activeElement),
            value: textarea.value,
            valueLength: textarea.value.length,
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd,
            data: inputEvent.data,
            dataCodePoints: getCodePoints(inputEvent.data),
            inputType: inputEvent.inputType,
            isComposing: inputEvent.isComposing,
            cancelable: event.cancelable,
            defaultPrevented: event.defaultPrevented,
            appState: {
              ...getDebugState(),
              replayReason,
            },
          })
          if (event.cancelable) {
            event.preventDefault()
          }
        }
      }
    }

    const handleCompositionStart = () => {
      logInputEvent({
        terminalId,
        source: 'textarea',
        type: 'compositionstart-handler-before',
        target: describeElement(textarea),
        value: textarea.value,
        valueLength: textarea.value.length,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        appState: getDebugState(),
      })
      isComposingRef.current = true
      compositionStartValueRef.current = textarea.value
      compositionTextRef.current = ''
      if (compositionEndTimeoutRef.current) {
        clearTimeout(compositionEndTimeoutRef.current)
        compositionEndTimeoutRef.current = null
      }
      clearImeEchoData()
      clearRecentInputText()
      logInputEvent({
        terminalId,
        source: 'textarea',
        type: 'compositionstart-handler-after',
        target: describeElement(textarea),
        value: textarea.value,
        valueLength: textarea.value.length,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
        appState: getDebugState(),
      })
    }

    const handleCompositionUpdate = (event: CompositionEvent) => {
      logEvent('textarea', event)
      compositionTextRef.current = getComposedText(textarea, compositionStartValueRef.current, event.data)
    }

    const handleCompositionEnd = (event: CompositionEvent) => {
      logEvent('textarea', event)
      compositionTextRef.current = getComposedText(
        textarea,
        compositionStartValueRef.current,
        event.data || compositionTextRef.current
      )

      // xterm finalizes composition with a queued textarea substring. On mobile
      // IMEs that substring can be truncated, so keep our gate closed for that
      // queued send and emit the textarea diff ourselves afterwards.
      compositionEndTimeoutRef.current = setTimeout(() => {
        compositionEndTimeoutRef.current = null
        const data = getComposedText(textarea, compositionStartValueRef.current, compositionTextRef.current)
        isComposingRef.current = false
        compositionStartValueRef.current = ''
        compositionTextRef.current = ''

        sendCommittedImeText(data)
      }, 0)
    }

    const handleClipboardPaste = (event: ClipboardEvent) => {
      const imageFile = getClipboardImageFile(event)
      if (!imageFile) return

      event.preventDefault()
      event.stopPropagation()
      void readFileAsBase64(imageFile)
        .then((dataBase64) => {
          terminalSocket.send({
            type: 'paste-image',
            terminalId,
            mimeType: imageFile.type,
            dataBase64,
          })
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : 'Failed to paste clipboard image'
          logInputEvent({
            terminalId,
            source: 'app.clipboardImagePaste',
            type: 'paste-image-error',
            target: describeElement(textarea),
            activeElement: describeElement(document.activeElement),
            value: textarea.value,
            valueLength: textarea.value.length,
            selectionStart: textarea.selectionStart,
            selectionEnd: textarea.selectionEnd,
            data: message,
            appState: getDebugState(),
          })
        })
    }

    const handleTextInput = (event: Event) => {
      const inputEvent = event as InputEvent
      logEvent('textarea', event)

      if (!isComposingRef.current) {
        if (isVoiceCaptureActive()) {
          if (inputEvent.inputType === 'insertText' && inputEvent.data) {
            const remainingText = consumeRecentVoiceXtermText(inputEvent.data)
            const fallbackText = remainingText ?? inputEvent.data
            if (!fallbackText) return

            logAppData('app.voiceInputFallback', fallbackText)
            stageVoiceTextData(fallbackText)
          } else if (inputEvent.inputType === 'deleteContentBackward') {
            logAppData('app.voiceDeletionFallback', '\x7f')
            stageVoiceDeletionData('\x7f')
          }
          return
        }
        if (inputEvent.inputType === 'insertText' && inputEvent.data) {
          sendInputEventText(inputEvent.data)
        }
        return
      }

      compositionTextRef.current = getComposedText(
        textarea,
        compositionStartValueRef.current,
        inputEvent.data || compositionTextRef.current
      )

      const committedText = getCommittedImeInputText(inputEvent, compositionTextRef.current)
      if (committedText) {
        sendCommittedImeText(committedText)
        return
      }
    }

    const inputEventNames = [
      'keydown',
      'keypress',
      'keyup',
      'beforeinput',
      'input',
      'textInput',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'paste',
      'copy',
      'cut',
      'change',
      'select',
      'focus',
      'blur',
      'focusin',
      'focusout',
      'mousedown',
      'mouseup',
      'click',
      'touchstart',
      'touchend',
      'touchcancel',
      'pointerdown',
      'pointerup',
      'pointercancel',
    ]

    const passiveLoggers: Array<{
      target: EventTarget
      name: string
      listener: EventListener
      options?: AddEventListenerOptions
    }> = []

    const addPassiveLogger = (
      target: EventTarget,
      source: string,
      names: string[],
      options?: AddEventListenerOptions
    ) => {
      for (const name of names) {
        const listener = ((event: Event) => logEvent(source, event)) as EventListener
        target.addEventListener(name, listener, options)
        passiveLoggers.push({ target, name, listener, options })
      }
    }

    textarea.addEventListener('paste', handleClipboardPaste, true)
    textarea.addEventListener('beforeinput', handleBeforeInput, true)
    textarea.addEventListener('compositionstart', handleCompositionStart)
    textarea.addEventListener('compositionupdate', handleCompositionUpdate)
    textarea.addEventListener('compositionend', handleCompositionEnd)
    textarea.addEventListener('input', handleTextInput)
    if (debugInputEventsEnabled) {
      addPassiveLogger(textarea, 'textarea.capture', inputEventNames, { capture: true })
      addPassiveLogger(textarea, 'textarea.bubble', inputEventNames)
      if (term.element) {
        addPassiveLogger(term.element, 'xterm.element.capture', inputEventNames, { capture: true })
        addPassiveLogger(term.element, 'xterm.element.bubble', inputEventNames)
      }
      addPassiveLogger(containerRef.current, 'container.capture', inputEventNames, { capture: true })
      addPassiveLogger(document, 'document.capture', [...inputEventNames, 'selectionchange'], { capture: true })
    }

    // Handle input
    const disposable = term.onData((data) => {
      logAppData('xterm.onData', data)
      if (isComposingRef.current) {
        return
      }

      const remainingEcho = consumePendingImeEcho(data, imeEchoDataRef.current)
      if (remainingEcho != null) {
        imeEchoDataRef.current = remainingEcho
        return
      }

      forwardTerminalData(data)
    })

    termRef.current = term
    fitAddonRef.current = fitAddon
    const actions: TerminalViewActions = {
      copySelection: () => copyText(getTerminalSelectionText()),
      focus: () => term.focus(),
      sendInput: forwardTerminalData,
      scrollLines: (delta: number) => {
        // delta < 0 = scroll up (older), delta > 0 = scroll down (newer)
        sendScroll(delta < 0, Math.abs(delta))
      },
    }
    actionsRef.current = actions
    onActionsChangeRef.current?.(actions)

    const resizeObserver = new ResizeObserver(() => {
      fitResizeAndMaybeScroll()
    })

    resizeObserver.observe(containerRef.current)

    const scrollDisposable = term.onScroll(() => {
      const buffer = term.buffer.active
      atBottomRef.current = buffer.viewportY >= buffer.baseY
      nativeTouchScrollLayer.refresh()
    })

    // xterm already keeps the viewport pinned while it is at the bottom and
    // holds position when scrolled up. Forcing scrollToBottom here raced with
    // user scrolls during streaming output and yanked the viewport back down,
    // so only keep the touch-scroll layer's size in sync.
    const writeParsedDisposable = term.onWriteParsed(() => {
      nativeTouchScrollLayer.refresh()
    })

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        fitResizeAndMaybeScroll()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    let pendingOutput = ''
    let outputWriteFrameId: number | null = null
    let outputWriteInProgress = false

    const scheduleOutputWrite = () => {
      if (outputWriteFrameId != null || outputWriteInProgress) return
      outputWriteFrameId = requestAnimationFrame(writePendingOutput)
    }

    function writePendingOutput() {
      outputWriteFrameId = null
      if (outputWriteInProgress || !pendingOutput) return

      const data = pendingOutput.slice(0, MAX_OUTPUT_CHARS_PER_FRAME)
      pendingOutput = pendingOutput.slice(data.length)
      outputWriteInProgress = true

      term.write(data, () => {
        outputWriteInProgress = false
        if (pendingOutput) {
          scheduleOutputWrite()
        }
      })
    }

    const enqueueOutput = (data: string) => {
      pendingOutput += data
      scheduleOutputWrite()
    }

    // Handle messages
    const unsubscribe = terminalSocket.onMessage((message) => {
      if (
        message.type !== 'attached' &&
        message.type !== 'output' &&
        message.type !== 'exit' &&
        message.type !== 'error'
      ) {
        return
      }
      if (message.terminalId !== terminalId) return

      if (message.type === 'attached') {
        // The server replays its full output buffer after every attach. Reset
        // in-band through the write queue so a reconnect replay replaces the
        // existing content instead of appending a duplicate copy.
        pendingOutput = ''
        enqueueOutput('\x1bc')
        return
      }

      if (message.type === 'output') {
        enqueueOutput(message.data)
      }

      if (message.type === 'exit') {
        enqueueOutput(`\r\n\x1b[33mTerminal exited with code ${message.exitCode ?? ''}\x1b[0m\r\n`)
      }

      if (message.type === 'error' && message.code === 'PTY_NOT_FOUND') {
        enqueueOutput('\r\n\x1b[31mTerminal session is no longer available. Reopen or restart the terminal.\x1b[0m\r\n')
      }
    })
    const unsubscribeReconnect = terminalSocket.onReconnect(() => {
      terminalAttached = false
      if (attachTerminal()) {
        requestAnimationFrame(scrollToBottom)
      }
    })

    const keepMobileKeyboardOpen = shouldUseNativeTouchScrollLayer()
    const refocusTerminal = () => {
      if (!keepMobileKeyboardOpen || document.hidden) return
      requestAnimationFrame(() => term.focus())
    }
    if (keepMobileKeyboardOpen) {
      textarea.addEventListener('blur', refocusTerminal)
    }

    term.focus()

    return () => {
      unsubscribe()
      unsubscribeReconnect()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      textarea.removeEventListener('paste', handleClipboardPaste, true)
      textarea.removeEventListener('beforeinput', handleBeforeInput, true)
      textarea.removeEventListener('compositionstart', handleCompositionStart)
      textarea.removeEventListener('compositionupdate', handleCompositionUpdate)
      textarea.removeEventListener('compositionend', handleCompositionEnd)
      textarea.removeEventListener('input', handleTextInput)
      textarea.removeEventListener('blur', refocusTerminal)
      for (const logger of passiveLoggers) {
        logger.target.removeEventListener(logger.name, logger.listener, logger.options)
      }
      if (compositionEndTimeoutRef.current) {
        clearTimeout(compositionEndTimeoutRef.current)
        compositionEndTimeoutRef.current = null
      }
      clearImeEchoData()
      clearRecentXtermData()
      clearRecentInputText()
      clearVoiceFinalizationTimer()
      clearVoiceDrainTimer()
      voiceInputDrainingRef.current = false
      startVoiceInputRef.current = null
      stopVoiceInputRef.current = null
      if (cachedSelectionTimeoutId) {
        clearTimeout(cachedSelectionTimeoutId)
      }
      if (initialAttachFrameId != null) {
        cancelAnimationFrame(initialAttachFrameId)
      }
      if (resizeFrameId != null) {
        cancelAnimationFrame(resizeFrameId)
      }
      if (outputWriteFrameId != null) {
        cancelAnimationFrame(outputWriteFrameId)
      }
      pendingOutput = ''
      container.removeEventListener('mousedown', handleMouseDownForCopy, true)
      container.removeEventListener('mousemove', handleMouseMoveForCopy, true)
      container.removeEventListener('mouseup', handleMouseUpForCopy, true)
      document.removeEventListener('selectionchange', updateCachedSelectionText)
      nativeTouchScrollLayer.dispose()
      resizeObserver.disconnect()
      scrollDisposable.dispose()
      writeParsedDisposable.dispose()
      disposable.dispose()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
      actionsRef.current = null
      onActionsChangeRef.current?.(null)
    }
  }, [fontSize, resolvedTheme, terminalId])

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <div ref={containerRef} className="h-full min-h-0 w-full overflow-hidden" />
      {!onVoiceDraftChange && voiceDraft && (
        <div className="pointer-events-none absolute inset-x-2 top-2 z-10 max-h-24 overflow-hidden border px-2 py-1 text-sm app-panel-strong shadow-sm">
          {voiceDraft}
        </div>
      )}
    </div>
  )
}
