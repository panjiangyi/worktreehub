import { describe, expect, it } from 'vitest'
import { getCommittedImeInputText } from './ime-input.js'

describe('IME input commit detection', () => {
  it('does not commit incremental macOS dictation composition updates', () => {
    const updates = [
      'Hello，he',
      'Hello，hello，',
      'Hello，hello，你',
      'Hello，hello，你好。',
      '哈喽哈喽，你好你好。',
    ]

    expect(
      updates.map((text) =>
        getCommittedImeInputText(
          { inputType: 'insertCompositionText', isComposing: true },
          text
        )
      )
    ).toEqual(updates.map(() => null))
  })

  it('commits input events that explicitly finish a composition', () => {
    expect(
      getCommittedImeInputText(
        { inputType: 'insertFromComposition', isComposing: false },
        '最终结果'
      )
    ).toBe('最终结果')
  })
})
