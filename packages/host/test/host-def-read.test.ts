// `host.def.read`（只读解析能力）：投影只回引用后，服务按哈希取 def body。
// 覆盖：正常解析、缺失 / 越权 fail-closed、形态非法、哈希数上限、身份缺失。

import { describe, expect, it } from 'vitest'
import { AuditIndex } from '../audit.ts'
import { createHostCapability } from '../host-capability.ts'
import type { Hash, Json, World } from '../../kernel/index.ts'

const M1: Hash = '1'.repeat(64)
const M2: Hash = '2'.repeat(64)
const OUT: Hash = '9'.repeat(64)

function worldOf(): World {
  return {
    defs: {
      [M1]: { body: { role: 'assistant', prev: { def: M2 } } },
      [M2]: { body: { role: 'user', prev: null } },
      [OUT]: { body: { secret: true } },
    },
    ids: {
      sess: {
        id: 'sess',
        schema: 's'.repeat(64),
        gens: [
          {
            seq: 0,
            payload: M1,
            pins: {},
            sig: M1,
            adopted: { at: 1, by: 'seed', write: 'w-1' },
          },
        ],
        active: M1,
        born: { at: 1, by: 'seed' },
      },
    },
  }
}

function capability(world: World) {
  return createHostCapability({
    assetsDir: 'assets',
    blobsDir: 'blobs',
    runtimeDir: 'runtime',
    audits: new AuditIndex(),
    world: () => world,
    abortRun: () => false,
    startDetachedRun: () => ({ ok: true, run: 'r' }),
    isStopping: () => false,
  })
}

async function read(world: World, args: Json) {
  return capability(world)('def.read', 'sess', args, 1000)
}

describe('host.def.read 只读解析', () => {
  it('解析从该身份投影 body 可达的 def，回 body；越权 / 未知 fail-closed', async () => {
    const result = await read(worldOf(), { identity: 'sess', hashes: [M1, M2, OUT] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as {
      defs: { [hash: string]: Json }
      missing: Hash[]
      denied: Hash[]
      truncated: boolean
    }
    // M2 = 投影 body 的直接标记，可达 → 返回；M1（自身 body 哈希）与 OUT 不在闭包内 → 越权
    expect(value.defs[M2]).toEqual({ role: 'user', prev: null })
    expect(value.defs[M1]).toBeUndefined()
    expect(value.denied).toEqual([M1, OUT])
    expect(value.truncated).toBe(false)
  })

  it('形态非法（非 64hex / 非数组 / 身份缺失 / 未知哈希越权）fail-closed', async () => {
    expect((await read(worldOf(), { identity: 'sess', hashes: ['not-a-hash'] })).ok).toBe(false)
    expect((await read(worldOf(), { identity: 'sess', hashes: 'x' as unknown as Json })).ok).toBe(
      false,
    )
    expect((await read(worldOf(), { identity: 'ghost', hashes: [M2] })).ok).toBe(false)
    expect((await read(worldOf(), { hashes: [M2] })).ok).toBe(false)
    const unknown = await read(worldOf(), { identity: 'sess', hashes: ['f'.repeat(64)] })
    expect(unknown.ok).toBe(true)
    if (unknown.ok) {
      expect((unknown.value as { denied: Hash[] }).denied).toEqual(['f'.repeat(64)])
    }
  })

  it('哈希数超上限 → def_read_too_many（有界）', async () => {
    const hashes = Array.from({ length: 257 }, (_, i) =>
      i.toString(16).padStart(64, '0'),
    ) as Hash[]
    const result = await read(worldOf(), { identity: 'sess', hashes })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('def_read_too_many')
  })

  it('只读：解析不改变世界', async () => {
    const world = worldOf()
    const before = JSON.stringify(world)
    await read(world, { identity: 'sess', hashes: [M1, M2] })
    expect(JSON.stringify(world)).toBe(before)
  })
})
