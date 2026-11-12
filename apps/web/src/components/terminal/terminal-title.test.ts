import { describe, expect, it } from 'vitest'
import { MAX_TERMINAL_TITLE_LENGTH, normalizeTerminalTitle } from './terminal-title.js'

describe('normalizeTerminalTitle', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeTerminalTitle('  build logs  ')).toBe('build logs')
  })

  it('rejects a blank title', () => {
    expect(normalizeTerminalTitle('   ')).toBeNull()
  })

  it('caps the title length', () => {
    const title = normalizeTerminalTitle(`x${'y'.repeat(200)}`)
    expect(title?.length).toBe(MAX_TERMINAL_TITLE_LENGTH)
  })
})
