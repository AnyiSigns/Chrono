import { describe, expect, it } from 'vitest'
import { projectBaseOnly } from '../index.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Head = { seq: number; hash: string | null }

const EMPTY_HEAD: Head = { seq: -1, hash: null }

describe('投影 projectBaseOnly', () => {
  it('返回 head 与 world_rev，不含世界内部结构', () => {
    const world = { defs: {}, ids: {} }
    const view = projectBaseOnly(world as any, EMPTY_HEAD)
    expect(view).toEqual({
      head: { seq: -1, hash: null },
      world_rev: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it('head 非空时携带 seq 与 hash', () => {
    const world = { defs: {}, ids: {} }
    const head: Head = { seq: 3, hash: 'a'.repeat(64) }
    const view = projectBaseOnly(world as any, head)
    expect((view as { head: Head }).head.seq).toBe(3)
    expect((view as { head: Head }).head.hash).toBe('a'.repeat(64))
  })
})
