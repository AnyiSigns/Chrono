import { describe, expect, it } from 'vitest'
import { EMPTY_HEAD, EMPTY_WORLD, worldRev } from '../../../kernel/index.ts'
import { projectBaseOnly } from '../index.ts'
import type { Hash, Head, Json, World } from '../../../kernel/index.ts'

const PAYLOAD: Hash = 'a'.repeat(64)
const SIG: Hash = 'b'.repeat(64)
const SCHEMA: Hash = 'c'.repeat(64)

/** 注入的非空基础世界：一个 active 身份、一个 retired 身份、一个 active 缺 def 的身份。 */
function injectedWorld(): World {
  return {
    defs: {
      [PAYLOAD]: { body: { tree: 'tree-hash', meta: { name: 'toy-alpha' } } },
    },
    ids: {
      'toy-alpha': {
        id: 'toy-alpha',
        schema: SCHEMA,
        gens: [
          {
            seq: 0,
            payload: PAYLOAD,
            pins: {},
            sig: SIG,
            adopted: { at: 7, by: 'seed', write: 'w-1' },
          },
        ],
        active: PAYLOAD,
        born: { at: 7, by: 'seed' },
      },
      'toy-retired': {
        id: 'toy-retired',
        schema: SCHEMA,
        gens: [
          {
            seq: 0,
            payload: 'd'.repeat(64),
            pins: {},
            sig: SIG,
            adopted: { at: 8, by: 'seed', write: 'w-2' },
          },
        ],
        active: null,
        born: { at: 8, by: 'seed' },
      },
      'toy-missing-def': {
        id: 'toy-missing-def',
        schema: SCHEMA,
        gens: [
          {
            seq: 3,
            payload: 'e'.repeat(64),
            pins: {},
            sig: SIG,
            adopted: { at: 9, by: 'seed', write: 'w-3' },
          },
        ],
        active: 'e'.repeat(64),
        born: { at: 9, by: 'seed' },
      },
    },
  }
}

type Projection = {
  head: Head
  world_rev: Hash
  ids: { [id: string]: { active: Hash | null; gens: Json[]; body: Json | null } }
}

describe('A14 base_only 投影', () => {
  it('EMPTY_WORLD 空基础不报错：head=EMPTY_HEAD、ids 为空、world_rev 有值', () => {
    const view = projectBaseOnly(EMPTY_WORLD, EMPTY_HEAD) as unknown as Projection
    expect(view).toEqual({
      head: { seq: -1, hash: null },
      world_rev: worldRev(EMPTY_WORLD),
      ids: {},
    })
    expect(view.world_rev).toMatch(/^[a-f0-9]{64}$/)
  })

  it('机械映射：身份字面 id 为键，active / 无履历 gens / active payload body', () => {
    const world = injectedWorld()
    const head: Head = { seq: 5, hash: 'f'.repeat(64) }
    const view = projectBaseOnly(world, head) as unknown as Projection

    expect(view.head).toEqual({ seq: 5, hash: 'f'.repeat(64) })
    expect(view.world_rev).toBe(worldRev(world))
    expect(Object.keys(view.ids).sort()).toEqual(['toy-alpha', 'toy-missing-def', 'toy-retired'])

    expect(view.ids['toy-alpha']).toEqual({
      active: PAYLOAD,
      gens: [{ seq: 0, payload: PAYLOAD }],
      body: { tree: 'tree-hash', meta: { name: 'toy-alpha' } },
    })
    // retired：active=null ⇒ body=null；gens 保留（世代可读，取用与否归 term）
    expect(view.ids['toy-retired'].active).toBeNull()
    expect(view.ids['toy-retired'].body).toBeNull()
    expect(view.ids['toy-retired'].gens).toEqual([{ seq: 0, payload: 'd'.repeat(64) }])
    // active 指向的 def 缺失：body=null（fail-closed，不抛）
    expect(view.ids['toy-missing-def'].active).toBe('e'.repeat(64))
    expect(view.ids['toy-missing-def'].body).toBeNull()
  })

  it('不暴露世界内部结构：不给 defs 表、gens 不含 adopted/born、body 不含 tree/blob 展开', () => {
    const view = projectBaseOnly(injectedWorld(), EMPTY_HEAD) as unknown as Json
    const record = view as { [k: string]: Json }
    expect(record['defs']).toBeUndefined()
    const ids = record['ids'] as { [k: string]: Json }
    const alpha = ids['toy-alpha'] as { [k: string]: Json }
    expect(Object.keys(alpha).sort()).toEqual(['active', 'body', 'gens'])
    const gen = (alpha['gens'] as Json[])[0] as { [k: string]: Json }
    expect(Object.keys(gen).sort()).toEqual(['payload', 'seq'])
    // body = payload def 的 body 原样（树是引用，不递归展开）
    expect(alpha['body']).toEqual({ tree: 'tree-hash', meta: { name: 'toy-alpha' } })
  })

  it('只读：构造不改变世界 / 链头输入；改投影值不影响世界', () => {
    const world = injectedWorld()
    const before = worldRev(world)
    const head: Head = { seq: 1, hash: 'f'.repeat(64) }
    const view = projectBaseOnly(world, head) as unknown as Projection

    expect(worldRev(world)).toBe(before)
    expect(world.ids['toy-alpha'].active).toBe(PAYLOAD)
    expect(head).toEqual({ seq: 1, hash: 'f'.repeat(64) })

    view.ids['toy-alpha'].active = null
    view.head.seq = 99
    expect(world.ids['toy-alpha'].active).toBe(PAYLOAD)
    expect(head.seq).toBe(1)
  })
})
