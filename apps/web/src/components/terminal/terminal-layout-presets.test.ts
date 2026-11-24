import { describe, expect, it } from 'vitest'
import { PRESETS, applyLayoutPreset, matchesIds, tileVisible } from './terminal-layout-presets.js'

const items = Array.from({length:6},(_,i)=>({i:String(i),x:i*2,y:0,w:2,h:12}))
describe('terminal layout presets',()=>{
  it('preserves identities and returns overflow instead of deleting terminals',()=>{
    const result=applyLayoutPreset(items,'leftThree')
    expect(result.layout.map(item=>item.i)).toEqual(['0','1','2','3'])
    expect(result.overflow).toEqual(['4','5'])
    expect(result.layout[0]).toMatchObject({x:0,y:0,w:8,h:12})
    expect(items[0].w).toBe(2)
  })
  it('all presets have non-overlapping slots within the grid',()=>{
    for (const preset of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      const {layout}=applyLayoutPreset(items,preset)
      for (const a of layout) {
        expect(a.x+a.w).toBeLessThanOrEqual(12)
        expect(a.y+a.h).toBeLessThanOrEqual(12)
        for (const b of layout.filter(item=>item.i!==a.i)) {
          expect(a.x<b.x+b.w && a.x+a.w>b.x && a.y<b.y+b.h && a.y+a.h>b.y).toBe(false)
        }
      }
    }
  })
  it('retile visible items and recognize layout membership',()=>{
    const visible=items.slice(2,5)
    const tiled=tileVisible(visible)
    expect(matchesIds(tiled,visible)).toBe(true)
    expect(matchesIds(tiled,items)).toBe(false)
    expect(tileVisible([])).toEqual([])
  })
})
