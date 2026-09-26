// 世界落点写入原语：CAS 串行、克隆 / 就地两种落点语义、落账失败的致命收口。

import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_HEAD, cloneWorld, commit } from '../../kernel/index.ts'
import type { Json, World, WriteRequest } from '../../kernel/index.ts'
import { WorldWriter } from '../writer.ts'
import { commitToWorld } from '../world-commit.ts'
import { fatalError, resetFatal } from '../effect/fatal.ts'

function put(id: string, body: Json): Omit<WriteRequest, 'target'> {
  return { id, op: 'put', args: { body }, by: 'test' }
}

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

describe('commitToWorld（世界落点写入原语）', () => {
  afterEach(() => resetFatal())

  it('单写者串行段：携带过期链头的提交被位置门禁拒 pos_conflict（CAS 生效）', async () => {
    const world = emptyWorld()
    const writer = new WorldWriter({ world, head: { ...EMPTY_HEAD } })
    // 首个提交经落点原语：默认锚定当前链头，成功并推进共享链头
    const first = await writer.run((state) => {
      const result = commitToWorld(
        { kind: 'writer', world: state.world, head: state.head },
        put('a', { v: 1 }),
        1,
        () => undefined,
      )
      if (result.kind === 'committed') {
        state.world = result.world
        state.head = result.head
      }
      return result
    })
    expect(first.kind).toBe('committed')
    const advanced = writer.snapshot().head

    // 第二个提交（并发的另一写者捕获了推进前的旧链头）携带过期 expect_pos：
    // 与段内当前链头不符 → 位置门禁拒，链头不推进。独立写者不共享链头时会各自分叉，
    // 故单写者 + 段内锚定是 CAS 成立的前提。
    const stale = await writer.run((state) => {
      const request: WriteRequest = {
        ...put('b', { v: 2 }),
        target: { expect_pos: EMPTY_HEAD.hash },
      }
      return commit(state.head, cloneWorld(state.world), request, 2).verdict
    })
    expect(stale.ok).toBe(false)
    expect(stale.reasons).toEqual(['pos_conflict'])
    expect(writer.snapshot().head).toEqual(advanced)
  })

  it('writer 落点克隆世界：提交不改传入的世界引用', () => {
    const world = emptyWorld()
    const result = commitToWorld(
      { kind: 'writer', world, head: { ...EMPTY_HEAD } },
      put('a', { v: 1 }),
      1,
      () => undefined,
    )
    expect(result.kind).toBe('committed')
    expect(Object.keys(world.defs)).toEqual([])
    if (result.kind === 'committed') expect(Object.keys(result.world.defs)).not.toEqual([])
  })

  it('lock 落点就地演化调用方独占的世界', () => {
    const world = emptyWorld()
    const result = commitToWorld(
      { kind: 'lock', world, head: { ...EMPTY_HEAD } },
      put('a', { v: 1 }),
      1,
      () => undefined,
    )
    expect(result.kind).toBe('committed')
    if (result.kind === 'committed') {
      expect(result.world).toBe(world)
      expect(Object.keys(world.defs)).not.toEqual([])
    }
  })

  it('落账失败：标记进程级致命并抛出，写者状态不推进', () => {
    const world = emptyWorld()
    expect(() =>
      commitToWorld(
        { kind: 'writer', world, head: { ...EMPTY_HEAD } },
        put('a', { v: 1 }),
        1,
        () => {
          throw new Error('disk full')
        },
      ),
    ).toThrow('disk full')
    expect(Object.keys(world.defs)).toEqual([])
    expect(fatalError()).not.toBeNull()
  })
})
