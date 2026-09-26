// 基础世界分片 + 按需加载验收：
// - v2 写读往返：索引小文件 + 分片，世界摘要与 def 逐一致；
// - 惰性：读索引 / 列键 / 算摘要不读分片（DefStore.stats.loads === 0），取 body 才按需读；
// - LRU：命中不重复读盘；
// - 未变分片复用：同一份 def 键集再写不重读 body；
// - 缺分片 fail-open（视作缺 def，不炸），分片目录整体缺失 → 视作无基础世界。

import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { H, canonicalJson, cloneWorld, worldRev } from '../../../kernel/index.ts'
import type { Def, Hash, Json, World } from '../../../kernel/index.ts'
import { DefStore, createLazyDefs, readBase, writeBase } from '../index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'

/** 造一个只有 defs、无身份的世界；每个 body 的键 = H({body})。 */
function worldWithDefs(bodies: Json[]): World {
  const defs: Record<Hash, Def> = {}
  for (const body of bodies) {
    const def: Def = { body }
    defs[H(def as unknown as Json)] = def
  }
  return { defs, ids: {} }
}

function indexOf(baseFile: string): { defs: string[]; defsDir: string; world?: unknown } {
  return JSON.parse(readFileSync(baseFile, 'utf8')) as {
    defs: string[]
    defsDir: string
    world?: unknown
  }
}

const SNAPSHOT = { seq: 7, hash: 'c'.repeat(64) }

describe('基础世界分片（v2）', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTempRoot(root)
  })

  function newRoot(): { root: string; baseFile: string } {
    const root = createTempRoot()
    roots.push(root)
    return { root, baseFile: join(root, 'state', 'world', 'base.json') }
  }

  it('写读往返：索引不含 world，分片目录落盘；摘要与 def 逐一致', () => {
    const { baseFile } = newRoot()
    const world = worldWithDefs([{ a: 1 }, { b: 2 }, { c: { deep: [1, 2, 3] } }])
    writeBase(baseFile, { snapshot: SNAPSHOT, world })

    const index = indexOf(baseFile)
    expect(index.defs).toHaveLength(3)
    expect(index.world).toBeUndefined()
    expect(existsSync(join(dirname(baseFile), index.defsDir))).toBe(true)

    const base = readBase(baseFile)
    expect(base).not.toBeNull()
    expect(base!.v).toBe(2)
    expect(worldRev(base!.world)).toBe(worldRev(world))
    for (const key of Object.keys(world.defs) as Hash[]) {
      expect(base!.world.defs[key]).toEqual(world.defs[key])
    }
  })

  it('按需加载：读索引 / 列键 / 算摘要零分片读，取 body 才读', () => {
    const { baseFile } = newRoot()
    const world = worldWithDefs([{ a: 1 }, { b: 2 }, { c: 3 }])
    writeBase(baseFile, { snapshot: SNAPSHOT, world })

    const base = readBase(baseFile)!
    expect(base.store!.stats.loads).toBe(0) // 读索引不碰分片
    expect(worldRev(base.world)).toBe(worldRev(world))
    expect(base.store!.stats.loads).toBe(0) // 摘要只吃键
    expect(Object.keys(base.world.defs).sort()).toEqual(Object.keys(world.defs).sort())
    expect(base.store!.stats.loads).toBe(0) // 列键不碰分片
    const key = Object.keys(world.defs)[0] as Hash
    expect(base.store!.has(key)).toBe(true)
    expect(base.store!.stats.loads).toBe(0) // 判存在只看清单

    expect(base.world.defs[key]).toEqual(world.defs[key])
    expect(base.store!.stats.loads).toBeGreaterThan(0) // 取 body 触发一次分片读
    const loads = base.store!.stats.loads
    expect(base.world.defs[key]).toEqual(world.defs[key])
    expect(base.store!.stats.loads).toBe(loads) // 命中缓存不再读盘
    expect(base.store!.stats.hits).toBeGreaterThan(0)
  })

  it('惰性表与普通表同形：in / Object.keys / cloneWorld 复制覆盖层且互不影响', () => {
    const { baseFile } = newRoot()
    const world = worldWithDefs([{ a: 1 }, { b: 2 }])
    writeBase(baseFile, { snapshot: SNAPSHOT, world })
    const base = readBase(baseFile)!
    const key = Object.keys(world.defs)[0] as Hash
    expect(key in base.world.defs).toBe(true)
    expect('f'.repeat(64) in base.world.defs).toBe(false)

    const clone = cloneWorld(base.world)
    const extra = 'e'.repeat(64) as Hash
    clone.defs[extra] = { body: { extra: true } }
    expect(clone.defs[extra]).toEqual({ body: { extra: true } })
    expect(extra in base.world.defs).toBe(false)
    expect(Object.keys(base.world.defs)).toHaveLength(2)
    expect(Object.keys(clone.defs)).toHaveLength(3)
  })

  it('缺分片 fail-open：视作缺 def，不抛；分片目录整体缺失 → null（回落全链）', () => {
    const { baseFile } = newRoot()
    const world = worldWithDefs([{ a: 1 }, { b: 2 }])
    writeBase(baseFile, { snapshot: SNAPSHOT, world })
    const index = indexOf(baseFile)
    const key = index.defs[0] as Hash
    const shardFile = join(dirname(baseFile), index.defsDir, `${key.slice(0, 2)}.jsonl`)
    expect(existsSync(shardFile)).toBe(true)
    rmSync(shardFile)
    const base = readBase(baseFile)
    expect(base).not.toBeNull()
    expect(base!.world.defs[key]).toBeUndefined() // 缺分片 = 缺 def
    expect(worldRev(base!.world)).toBe(worldRev(world)) // 摘要只吃键，仍自校通过

    rmSync(join(dirname(baseFile), index.defsDir), { recursive: true, force: true })
    expect(readBase(baseFile)).toBeNull()
  })

  it('E1：readBase 不 eager 自校；verify() 惰性算摘要、幂等且零分片读', () => {
    const { baseFile } = newRoot()
    const world = worldWithDefs([{ a: 1 }, { b: 2 }])
    writeBase(baseFile, { snapshot: SNAPSHOT, world })
    // 篡改 worldRev：readBase 仍返回（不 eager 自校），首次 verify 才 fail-closed
    const tampered = JSON.parse(readFileSync(baseFile, 'utf8')) as Record<string, unknown>
    tampered['worldRev'] = 'f'.repeat(64)
    writeFileSync(baseFile, JSON.stringify(tampered))
    const bad = readBase(baseFile)!
    expect(bad).not.toBeNull()
    expect(() => bad.verify()).toThrow('bad_base')

    // 正常 base：verify 通过后可重复调用（缓存 / 幂等），且摘要只吃键、零分片读
    writeBase(baseFile, { snapshot: SNAPSHOT, world })
    const good = readBase(baseFile)!
    expect(good.store!.stats.loads).toBe(0)
    expect(() => good.verify()).not.toThrow()
    expect(good.store!.stats.loads).toBe(0)
    expect(() => good.verify()).not.toThrow()
    expect(good.store!.stats.loads).toBe(0)
  })

  it('E4：未变分片复用：def 键集不变而身份变化时，新代目录分片字节与旧一致', () => {
    const { baseFile } = newRoot()
    const world = worldWithDefs([{ a: 1 }, { b: 2 }])
    const snapshot = { seq: 5, hash: 'c'.repeat(64) }
    writeBase(baseFile, { snapshot, world })
    const first = indexOf(baseFile)
    const shardBytes = first.defs.map((key) =>
      readFileSync(join(dirname(baseFile), first.defsDir, `${key.slice(0, 2)}.jsonl`), 'utf8'),
    )
    // 同一 def 键集、加上一个身份：worldRev 变、代目录换，但分片按前缀复用旧文件
    const withIdentity: World = {
      defs: world.defs,
      ids: {
        x: {
          id: 'x',
          schema: first.defs[0] as Hash,
          gens: [],
          active: null,
          born: { at: 1, by: 'test' },
        },
      },
    }
    writeBase(baseFile, { snapshot: { seq: 6, hash: 'd'.repeat(64) }, world: withIdentity })
    const second = indexOf(baseFile)
    expect(second.defsDir).not.toBe(first.defsDir)
    for (const [i, key] of second.defs.entries()) {
      expect(
        readFileSync(join(dirname(baseFile), second.defsDir, `${key.slice(0, 2)}.jsonl`), 'utf8'),
      ).toBe(shardBytes[i])
    }
    const reloaded = readBase(baseFile)!
    expect(worldRev(reloaded.world)).toBe(worldRev(withIdentity))
  })
})

describe('DefStore LRU', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTempRoot(root)
  })

  it('分片读一次后命中缓存：重复取同键不再读盘', () => {
    const root = createTempRoot()
    roots.push(root)
    const dir = join(root, 'defs')
    mkdirSync(dir, { recursive: true })
    const keys = ['aa', 'bb', 'cc'].map((prefix) => (prefix + '0'.repeat(62)) as Hash)
    for (const key of keys) {
      writeFileSync(
        join(dir, `${key.slice(0, 2)}.jsonl`),
        canonicalJson({ h: key, d: { body: { key } } }) + '\n',
      )
    }
    const store = new DefStore({ dir, shard: 2, hashes: keys })
    expect(store.has(keys[0])).toBe(true)
    expect(store.stats.loads).toBe(0)

    store.get(keys[0])
    store.get(keys[1])
    expect(store.cached()).toBe(2)
    expect(store.cachedBytes()).toBeGreaterThan(0)
    expect(store.stats.loads).toBe(2)

    const hitsBefore = store.stats.hits
    store.get(keys[0]) // 命中
    store.get(keys[1]) // 命中
    expect(store.stats.hits).toBe(hitsBefore + 2)
    expect(store.stats.loads).toBe(2)
  })
})

describe('惰性 defs 代理', () => {
  it('createLazyDefs：写覆盖层独立于底层，delete 隐藏键', () => {
    const root = createTempRoot()
    const store = new DefStore({
      dir: join(root, 'nope'),
      shard: 2,
      hashes: ['a'.repeat(64), 'b'.repeat(64)],
    })
    const defs = createLazyDefs(store)
    expect(Object.keys(defs).sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)].sort())
    defs['c'.repeat(64)] = { body: { c: true } }
    expect(Object.keys(defs)).toHaveLength(3)
    delete defs['a'.repeat(64)]
    expect('a'.repeat(64) in defs).toBe(false)
    expect(Object.keys(defs)).toHaveLength(2)
    void cleanupTempRoot(root)
  })
})
