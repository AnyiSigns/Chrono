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

type IdentityView = {
  active: Hash | null
  gens: Json[]
  body: Json | null
  refs: { [hash: string]: Json }
  next_before: Hash | null
}

type Projection = {
  head: Head
  world_rev: Hash
  ids: { [id: string]: IdentityView }
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
      refs: {},
      next_before: null,
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
    expect(Object.keys(alpha).sort()).toEqual(['active', 'body', 'gens', 'next_before', 'refs'])
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

  it('G7 A1：body 取最近数据世代；active 保持链上原义（数据世代 / 代码世代都可为 active）', () => {
    const world = injectedWorld()
    const dataPayload: Hash = '1'.repeat(64)
    const newerCode: Hash = '2'.repeat(64)
    world.defs[dataPayload] = { body: { hello: 'data' } }
    world.defs[newerCode] = { body: { tree: 'tree-2', meta: { name: 'toy-alpha' } } }
    // gens：commit0(PAYLOAD) → 数据(dataPayload) → 新 commit(newerCode)，active 指数据世代
    world.ids['toy-alpha'].gens.push(
      {
        seq: 1,
        payload: dataPayload,
        pins: {},
        sig: dataPayload,
        adopted: { at: 8, by: 'client', write: 'w-2' },
      },
      {
        seq: 2,
        payload: newerCode,
        pins: {},
        sig: newerCode,
        adopted: { at: 9, by: 'client', write: 'w-3' },
      },
    )
    world.ids['toy-alpha'].active = dataPayload

    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(view.ids['toy-alpha'].active).toBe(dataPayload)
    expect(view.ids['toy-alpha'].gens).toHaveLength(3)
    // 最近数据世代优先于 active（active 恰好是数据）也优先于更晚的代码世代
    expect(view.ids['toy-alpha'].body).toEqual({ hello: 'data' })

    // active 指回代码世代：body 仍是最近数据世代（读侧拿到数据）
    world.ids['toy-alpha'].active = newerCode
    const view2 = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(view2.ids['toy-alpha'].active).toBe(newerCode)
    expect(view2.ids['toy-alpha'].body).toEqual({ hello: 'data' })
  })

  it('G7 A1：无数据世代时 body 回落 active（代码 / commit def body）', () => {
    const world = injectedWorld()
    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(view.ids['toy-alpha'].body).toEqual({ tree: 'tree-hash', meta: { name: 'toy-alpha' } })
  })
})

/** 构造一个只有数据世代的身份：body = 给定数据，payload def body 不含 tree。 */
function worldWithDataBody(body: Json, defs: World['defs']): World {
  const payload: Hash = 'f'.repeat(64)
  return {
    defs: { ...defs, [payload]: { body } },
    ids: {
      sess: {
        id: 'sess',
        schema: SCHEMA,
        gens: [
          {
            seq: 0,
            payload,
            pins: {},
            sig: payload,
            adopted: { at: 1, by: 'test', write: 'w-0' },
          },
        ],
        active: payload,
        born: { at: 1, by: 'test' },
      },
    },
  }
}

describe('投影引用闭包 refs', () => {
  const msg1: Hash = '1'.repeat(64)
  const msg2: Hash = '2'.repeat(64)
  const msg3: Hash = '3'.repeat(64)

  it('从 body 出发跟随 {"def":hash} 传递闭包，全量收进 refs，next_before 恒 null', () => {
    const world = worldWithDataBody(
      { conversations: [{ head: { def: msg1 } }] },
      {
        [msg1]: { body: { role: 'assistant', prev: { def: msg2 } } },
        [msg2]: { body: { role: 'user', prev: { def: msg3 } } },
        [msg3]: { body: { role: 'user', prev: null } },
      },
    )
    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    const refs = view.ids['sess'].refs
    expect(Object.keys(refs).sort()).toEqual([msg1, msg2, msg3].sort())
    expect(refs[msg1]).toEqual({ role: 'assistant', prev: { def: msg2 } })
    expect(refs[msg3]).toEqual({ role: 'user', prev: null })
    expect(view.ids['sess'].next_before).toBeNull()
  })

  it('成环不无限展开：已访问哈希去重', () => {
    const world = worldWithDataBody(
      { head: { def: msg1 } },
      {
        [msg1]: { body: { prev: { def: msg2 } } },
        [msg2]: { body: { prev: { def: msg1 } } },
      },
    )
    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(Object.keys(view.ids['sess'].refs).sort()).toEqual([msg1, msg2].sort())
  })

  it('标记指向缺失 def → 跳过，不抛', () => {
    const missing: Hash = '9'.repeat(64)
    const world = worldWithDataBody({ head: { def: missing } }, {})
    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(view.ids['sess'].refs).toEqual({})
    expect(view.ids['sess'].next_before).toBeNull()
  })

  it('无标记 / body 为 null → refs 为空对象', () => {
    const world = worldWithDataBody({ version: 1 }, {})
    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(view.ids['sess'].refs).toEqual({})
  })

  it('形如 {def:"not-a-hash"} 不是 64hex → 不当引用标记', () => {
    const world = worldWithDataBody({ head: { def: 'not-a-hash' } }, {})
    const view = projectBaseOnly(world, EMPTY_HEAD) as unknown as Projection
    expect(view.ids['sess'].refs).toEqual({})
  })

  it('refCap 是硬上限：超出即停止收（防异常数据撑爆投影）', () => {
    const world = worldWithDataBody(
      { head: { def: msg1 } },
      {
        [msg1]: { body: { prev: { def: msg2 } } },
        [msg2]: { body: { prev: { def: msg3 } } },
        [msg3]: { body: { prev: null } },
      },
    )
    const view = projectBaseOnly(world, EMPTY_HEAD, { refCap: 2 }) as unknown as Projection
    expect(Object.keys(view.ids['sess'].refs)).toHaveLength(2)
  })
})
