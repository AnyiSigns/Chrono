import { describe, expect, it } from 'vitest'
import { RunRegistry } from '../run-registry.ts'

/** 取消记忆语义：`isCancelled` 只判「取消过」，不判「已正常结束」。 */
describe('RunRegistry.isCancelled', () => {
  it('abort 记取消；unregister 后仍判取消', () => {
    const registry = new RunRegistry(1)
    registry.register('r1', new AbortController())
    expect(registry.isCancelled('r1')).toBe(false)
    expect(registry.abort('r1')).toBe(true)
    expect(registry.isCancelled('r1')).toBe(true)
    registry.unregister('r1')
    // 摘除后仍记得取消过：挡住取消后仍补发的反向调用
    expect(registry.isCancelled('r1')).toBe(true)
  })

  it('正常收口（未取消）不判取消；未知 run 不判取消', () => {
    const registry = new RunRegistry(1)
    registry.register('r1', new AbortController())
    registry.unregister('r1')
    expect(registry.isCancelled('r1')).toBe(false)
    expect(registry.isCancelled('never-registered')).toBe(false)
  })

  it('未知 run abort 返回 false 且不记取消', () => {
    const registry = new RunRegistry(1)
    expect(registry.abort('r1')).toBe(false)
    expect(registry.isCancelled('r1')).toBe(false)
  })

  it('abortAll 记全部在册 run 取消', () => {
    const registry = new RunRegistry(1)
    registry.register('a', new AbortController())
    registry.register('b', new AbortController())
    registry.abortAll()
    expect(registry.isCancelled('a')).toBe(true)
    expect(registry.isCancelled('b')).toBe(true)
  })

  it('取消记忆有上限：最旧的被遗忘', () => {
    const registry = new RunRegistry(1)
    for (let i = 0; i < 300; i++) {
      registry.register(`r${i}`, new AbortController())
      registry.abort(`r${i}`)
      registry.unregister(`r${i}`)
    }
    expect(registry.isCancelled('r0')).toBe(false)
    expect(registry.isCancelled('r299')).toBe(true)
  })
})
