export type ImeInputEvent = Pick<InputEvent, 'inputType' | 'isComposing'>

export function getCommittedImeInputText(
  event: ImeInputEvent,
  compositionText: string
): string | null {
  const isCommitted =
    event.inputType === 'insertText' ||
    event.inputType === 'insertFromComposition' ||
    (event.inputType !== 'insertCompositionText' && event.isComposing === false)

  return isCommitted && compositionText ? compositionText : null
}
