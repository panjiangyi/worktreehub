import type { LayoutItem } from 'react-grid-layout'

export const PRESETS = {
  single: [[0,0,12,12]],
  split: [[0,0,6,12],[6,0,6,12]],
  leftOne: [[0,0,8,12],[8,0,4,12]],
  leftTwo: [[0,0,8,12],[8,0,4,6],[8,6,4,6]],
  leftThree: [[0,0,8,12],[8,0,4,4],[8,4,4,4],[8,8,4,4]],
  rightTwo: [[0,0,4,6],[0,6,4,6],[4,0,8,12]],
  four: [[0,0,6,6],[6,0,6,6],[0,6,6,6],[6,6,6,6]],
  topTwo: [[0,0,12,8],[0,8,6,4],[6,8,6,4]],
  six: [[0,0,4,6],[4,0,4,6],[8,0,4,6],[0,6,4,6],[4,6,4,6],[8,6,4,6]],
} as const
export type Preset = keyof typeof PRESETS
export const PRESET_LABELS: Record<Preset,string> = { single:'Single',split:'Equal split',leftOne:'Large left + 1',leftTwo:'Large left + 2',leftThree:'Large left + 3',rightTwo:'2 left + large right',four:'Four grid',topTwo:'Large top + 2',six:'Six grid' }

export function applyLayoutPreset(items: LayoutItem[], preset: Preset) {
  const slots = PRESETS[preset]
  const ordered = [...items].sort((a,b) => a.y-b.y || a.x-b.x)
  return { layout: ordered.slice(0,slots.length).map((item,i) => {
    const [x,y,w,h] = slots[i]
    return {...item,x,y,w,h}
  }), overflow: ordered.slice(slots.length).map(item=>item.i) }
}

export function tileVisible(items: LayoutItem[]): LayoutItem[] {
  if (!items.length) return []
  const cols = Math.ceil(Math.sqrt(items.length))
  const rows = Math.ceil(items.length / cols)
  return items.map((item,i) => {
    const row = Math.floor(i/cols), col = i%cols
    const count = Math.min(cols, items.length-row*cols)
    const x = Math.round(col*12/count), y = Math.round(row*12/rows)
    return {...item,x,y,w:Math.max(1,Math.round((col+1)*12/count)-x),h:Math.max(1,Math.round((row+1)*12/rows)-y)}
  })
}

export function matchesIds(a: readonly LayoutItem[], b: readonly LayoutItem[]) {
  return a.length === b.length && a.every(item => b.some(other=>other.i===item.i))
}
