import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'
import { MAX_TERMINAL_TITLE_LENGTH, normalizeTerminalTitle } from './terminal-title.js'

type Props = {
  title: string
  onRename: (title: string) => void | Promise<void>
  onActivate?: () => void
}

export function TerminalTitleField({ title, onRename, onActivate }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const inputRef = useRef<HTMLInputElement>(null)
  const committingRef = useRef(false)

  useEffect(() => {
    if (!editing) setDraft(title)
  }, [editing, title])

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const cancel = () => {
    setDraft(title)
    setEditing(false)
  }

  const commit = () => {
    if (committingRef.current) return
    committingRef.current = true
    setEditing(false)

    const next = normalizeTerminalTitle(draft)
    if (!next || next === title) {
      setDraft(title)
    } else {
      setDraft(next)
      void Promise.resolve(onRename(next)).catch(() => setDraft(title))
    }

    queueMicrotask(() => {
      committingRef.current = false
    })
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        maxLength={MAX_TERMINAL_TITLE_LENGTH}
        aria-label="Terminal name"
        className="terminal-pane-control h-5 min-w-0 flex-1 rounded border bg-[var(--color-panel)] px-1 text-xs outline-none border-[var(--color-border-strong)] focus:border-[var(--color-accent)]"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation()
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            cancel()
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      />
    )
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {onActivate ? (
        <button
          type="button"
          onClick={onActivate}
          className="min-w-0 flex-1 truncate text-left"
          title={title}
        >
          {title}
        </button>
      ) : (
        <span className="truncate" title={title}>
          {title}
        </span>
      )}
      <button
        type="button"
        className="terminal-pane-control app-icon-button shrink-0 p-0.5"
        title="Rename terminal"
        aria-label="Rename terminal"
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          event.preventDefault()
          setEditing(true)
        }}
      >
        <Pencil className="h-3 w-3" />
      </button>
    </div>
  )
}
