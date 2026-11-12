export const MAX_TERMINAL_TITLE_LENGTH = 120

export function normalizeTerminalTitle(value: string): string | null {
  const title = value.trim().slice(0, MAX_TERMINAL_TITLE_LENGTH)
  return title.length > 0 ? title : null
}
