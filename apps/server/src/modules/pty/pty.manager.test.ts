import { describe, expect, it } from 'vitest'
import { buildInteractivePtyEnv, stripTerminalQuerySequences } from './pty.manager.js'

describe('buildInteractivePtyEnv', () => {
  it('does not leak NO_COLOR from the server into interactive terminals', () => {
    const env = buildInteractivePtyEnv(
      { PATH: '/usr/bin', NO_COLOR: '1' },
      { WORKTREEHUB_PROJECT_ID: 'project-1', NO_COLOR: '1' },
      { PROMPT_DIRTRIM: '1', NO_COLOR: '1' },
      'terminal-1'
    )

    expect(env).not.toHaveProperty('NO_COLOR')
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      WORKTREEHUB: '1',
      WORKTREEHUB_TERMINAL_ID: 'terminal-1',
      WORKTREEHUB_PROJECT_ID: 'project-1',
      PROMPT_DIRTRIM: '1',
    })
  })
})

describe('stripTerminalQuerySequences', () => {
  it('removes device attribute queries from replay output', () => {
    expect(stripTerminalQuerySequences(`before\x1b[>0cafter`)).toBe('beforeafter')
  })

  it('removes OSC color responses terminated by ST or BEL', () => {
    const output = [
      'before',
      '\x1b]10;rgb:1616/2020/3131\x1b\\',
      '\x1b]11;rgb:f7f7/f9f9/fcfc\x07',
      'after',
    ].join('')

    expect(stripTerminalQuerySequences(output)).toBe('beforeafter')
  })

  it('preserves color-like text that is not an OSC response', () => {
    expect(stripTerminalQuerySequences('10;rgb:1616/2020/3131')).toBe(
      '10;rgb:1616/2020/3131'
    )
  })
})
