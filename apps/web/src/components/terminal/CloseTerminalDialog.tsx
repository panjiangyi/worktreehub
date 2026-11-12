import { useEffect, useRef } from 'react'

type Props = {
  title: string
  onCancel: () => void
  onConfirm: () => void
}

export function CloseTerminalDialog({ title, onCancel, onConfirm }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    cancelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [onCancel])

  return (
    <div
      className="app-dialog-overlay"
      style={{ zIndex: 80 }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel()
      }}
    >
      <div
        className="app-dialog app-dialog-mobile max-w-[420px]"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="close-terminal-title"
        aria-describedby="close-terminal-description"
      >
        <div className="app-dialog-header">
          <h2 id="close-terminal-title" className="text-lg font-medium">Close terminal</h2>
        </div>
        <div className="space-y-4 p-4">
          <p id="close-terminal-description" className="text-sm">
            Close <span className="font-medium">{title}</span>? This session will end.
          </p>
          <div className="flex justify-end gap-2">
            <button ref={cancelRef} type="button" className="app-button-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="app-button-danger" onClick={onConfirm}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
