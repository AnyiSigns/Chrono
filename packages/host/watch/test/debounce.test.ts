// watcher 静默窗口单测：窗口内多次事件合并为一次（尾沿触发），dispose 取消未触发的一次。

import { describe, expect, it } from 'vitest'
import { Debouncer } from '../debounce.ts'

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('watcher 防抖（静默窗口）', () => {
  it('窗口内多次事件只触发一次', async () => {
    let count = 0
    const debouncer = new Debouncer(40, () => {
      count += 1
    })
    for (let i = 0; i < 5; i++) {
      debouncer.schedule()
      await sleep(5)
    }
    expect(count).toBe(0)
    await sleep(90)
    expect(count).toBe(1)
    debouncer.dispose()
  })

  it('dispose 取消未触发的一次', async () => {
    let count = 0
    const debouncer = new Debouncer(30, () => {
      count += 1
    })
    debouncer.schedule()
    debouncer.dispose()
    await sleep(70)
    expect(count).toBe(0)
  })
})
