import { describe, expect, it } from 'vitest'
import {
  buildCapabilityIndex,
  capabilityContract,
  capabilityOwners,
  capabilityProviders,
  effectiveMethods,
  manyNeedsOf,
  parsePluginDecl,
} from '../index.ts'
import type { CapabilityIndex, PluginDecl } from '../index.ts'
import { GEN_FACTS_CACHE_MAX, capabilityFactsCacheSize } from '../capability-index.ts'
import { H } from '../../../kernel/index.ts'
import type { Def, Gen, Hash, Identity, Json, World } from '../../../kernel/index.ts'

interface DeclSpec {
  identity: string
  implements?: string[]
  methods?: Record<string, string[]>
  pins?: Record<string, string>
  needs?: Record<string, { mode: string; methods?: string[] }>
  slots?: Record<string, { methods: string[] }>
}

function fullDecl(spec: DeclSpec): Json {
  return {
    identity: spec.identity,
    implements: spec.implements ?? [],
    methods: spec.methods ?? {},
    pins: spec.pins ?? {},
    ...(spec.needs === undefined ? {} : { needs: spec.needs as Json }),
    ...(spec.slots === undefined ? {} : { slots: spec.slots as Json }),
    start: '',
    build: [],
    protocol: '1',
    restart: {},
    health: {},
    state: 'recomputable',
    members: [],
    commands: [],
  }
}

function declOf(spec: DeclSpec): PluginDecl {
  const result = parsePluginDecl(fullDecl(spec))
  if (!result.ok) throw new Error(`测试声明非法: ${result.reasons.join(',')}`)
  return result.decl
}

/** 构造一个代码世代的 def 集合：commit def → tree def → plugin.json blob。 */
function codeGenDefs(spec: DeclSpec): { payload: Hash; defs: Record<Hash, Def> } {
  const text = JSON.stringify(fullDecl(spec))
  const jsonHash = H(text)
  const entries = [{ name: 'plugin.json', mode: 'file', hash: jsonHash }]
  const treeHash = H({ entries })
  const payload = H({ tree: treeHash })
  return {
    payload,
    defs: {
      [jsonHash]: { body: text },
      [treeHash]: { body: { entries } },
      [payload]: { body: { tree: treeHash }, sig: payload },
    },
  }
}

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

function addIdentity(world: World, id: string): Identity {
  const identity: Identity = {
    id,
    schema: H(`schema:${id}`),
    gens: [],
    active: null,
    born: { at: 0, by: '' },
  }
  world.ids[id] = identity
  return identity
}

function genOf(identity: Identity, payload: Hash): Gen {
  return {
    seq: identity.gens.length,
    payload,
    pins: {},
    sig: payload,
    adopted: { at: 0, by: '', write: '' },
  }
}

function addCodeGen(world: World, id: string, spec: DeclSpec): Hash {
  const { payload, defs } = codeGenDefs(spec)
  Object.assign(world.defs, defs)
  const identity = world.ids[id]
  identity.gens.push(genOf(identity, payload))
  identity.active = payload
  return payload
}

function addDataGen(world: World, id: string): Hash {
  const identity = world.ids[id]
  const payload = H(`data:${id}:${identity.gens.length}`)
  world.defs[payload] = { body: { note: 'data' } }
  identity.gens.push(genOf(identity, payload))
  identity.active = payload
  return payload
}

describe('能力索引 capability-index', () => {
  describe('提供方 / 拥有方', () => {
    it('按身份名字典序，providers / owners 与整表一致', () => {
      const world = emptyWorld()
      for (const id of ['z-prov', 'a-prov']) {
        addIdentity(world, id)
        addCodeGen(world, id, { identity: id, implements: ['cap'] })
      }
      for (const id of ['b-owner', 'a-owner']) {
        addIdentity(world, id)
        addCodeGen(world, id, { identity: id, slots: { cap: { methods: ['m'] } } })
      }
      expect(capabilityProviders(world, 'cap')).toEqual(['a-prov', 'z-prov'])
      expect(capabilityOwners(world, 'cap')).toEqual(['a-owner', 'b-owner'])
      const index: CapabilityIndex = buildCapabilityIndex(world)
      expect(index.providers.get('cap')).toEqual(['a-prov', 'z-prov'])
      expect(index.owners.get('cap')).toEqual(['a-owner', 'b-owner'])
      expect(capabilityProviders(world, 'missing')).toEqual([])
      expect(capabilityOwners(world, 'missing')).toEqual([])
    })

    it('退役（active = null）身份不入索引', () => {
      const world = emptyWorld()
      addIdentity(world, 'retired')
      addCodeGen(world, 'retired', { identity: 'retired', implements: ['cap'] })
      world.ids['retired'].active = null
      expect(capabilityProviders(world, 'cap')).toEqual([])
    })

    it('声明读不出（数据世代 / 缺 plugin.json）的身份静默缺席', () => {
      const world = emptyWorld()
      addIdentity(world, 'data-only')
      addDataGen(world, 'data-only')

      // 代码世代存在但 plugin.json blob 未落：声明读不出，同样缺席
      addIdentity(world, 'missing-json')
      const text = JSON.stringify(fullDecl({ identity: 'missing-json', implements: ['cap'] }))
      const jsonHash = H(text)
      const entries = [{ name: 'plugin.json', mode: 'file', hash: jsonHash }]
      const treeHash = H({ entries })
      const payload = H({ tree: treeHash })
      world.defs[treeHash] = { body: { entries } }
      world.defs[payload] = { body: { tree: treeHash }, sig: payload }
      world.ids['missing-json'].gens.push(genOf(world.ids['missing-json'], payload))
      world.ids['missing-json'].active = payload

      expect(capabilityProviders(world, 'cap')).toEqual([])
    })

    it('保留能力类 host 不入索引', () => {
      const world = emptyWorld()
      addIdentity(world, 'hostlike')
      addCodeGen(world, 'hostlike', { identity: 'hostlike', implements: ['host'] })
      expect(capabilityProviders(world, 'host')).toEqual([])
      // 提供方声明了 host 外的能力类时照常入索引
      expect(capabilityProviders(world, 'missing')).toEqual([])
    })

    it('set_active 回滚：按 active 世代声明解析，而非最近世代', () => {
      const world = emptyWorld()
      addIdentity(world, 'rolled')
      const first = addCodeGen(world, 'rolled', { identity: 'rolled', implements: ['cap'] })
      addCodeGen(world, 'rolled', { identity: 'rolled', implements: ['other'] })
      world.ids['rolled'].active = first
      expect(capabilityProviders(world, 'cap')).toEqual(['rolled'])
      expect(capabilityProviders(world, 'other')).toEqual([])
    })

    it('active 是数据世代时仍取最近代码世代声明', () => {
      const world = emptyWorld()
      addIdentity(world, 'mixed')
      addCodeGen(world, 'mixed', { identity: 'mixed', implements: ['cap'] })
      addDataGen(world, 'mixed')
      expect(capabilityProviders(world, 'cap')).toEqual(['mixed'])
    })
  })

  describe('many 成员表 manyNeedsOf', () => {
    it('逐个 many 需求解析世界提供方（码元序，排除 one / 自身）', () => {
      const world = emptyWorld()
      for (const id of ['prov-z', 'prov-a']) {
        addIdentity(world, id)
        addCodeGen(world, id, { identity: id, implements: ['capA'] })
      }
      addIdentity(world, 'one-prov')
      addCodeGen(world, 'one-prov', { identity: 'one-prov', implements: ['capB'] })
      addIdentity(world, 'consumer')
      addCodeGen(world, 'consumer', {
        identity: 'consumer',
        needs: { capA: { mode: 'many' }, capB: { mode: 'one' } },
      })
      expect(manyNeedsOf(world, 'consumer')).toEqual({ capA: ['prov-a', 'prov-z'] })
    })

    it('无 many 需求 → 空表；身份缺失 / 声明读不出 → null', () => {
      const world = emptyWorld()
      addIdentity(world, 'consumer')
      addCodeGen(world, 'consumer', {
        identity: 'consumer',
        needs: { capB: { mode: 'one' } },
      })
      expect(manyNeedsOf(world, 'consumer')).toEqual({})
      expect(manyNeedsOf(world, 'missing')).toBeNull()
    })

    it('退役提供方不入 many 成员表', () => {
      const world = emptyWorld()
      addIdentity(world, 'live')
      addCodeGen(world, 'live', { identity: 'live', implements: ['capA'] })
      addIdentity(world, 'gone')
      addCodeGen(world, 'gone', { identity: 'gone', implements: ['capA'] })
      world.ids['gone'].active = null
      addIdentity(world, 'consumer')
      addCodeGen(world, 'consumer', { identity: 'consumer', needs: { capA: { mode: 'many' } } })
      expect(manyNeedsOf(world, 'consumer')).toEqual({ capA: ['live'] })
    })
  })

  describe('契约 capabilityContract', () => {
    it('取第一个拥有方（字典序）的 methods；无拥有方为 null', () => {
      const world = emptyWorld()
      for (const [id, method] of [
        ['b-owner', 'm2'],
        ['a-owner', 'm1'],
      ] as const) {
        addIdentity(world, id)
        addCodeGen(world, id, { identity: id, slots: { cap: { methods: [method] } } })
      }
      expect(capabilityContract(world, 'cap')).toEqual(['m1'])
      expect(capabilityContract(world, 'missing')).toBeNull()
    })

    it('返回副本：改动返回值不影响缓存事实', () => {
      const world = emptyWorld()
      addIdentity(world, 'owner')
      addCodeGen(world, 'owner', { identity: 'owner', slots: { cap: { methods: ['m'] } } })
      const first = capabilityContract(world, 'cap') as string[]
      first.push('injected')
      expect(capabilityContract(world, 'cap')).toEqual(['m'])
    })
  })

  describe('有效方法集 effectiveMethods', () => {
    function worldWithProviderAndOwner(): World {
      const world = emptyWorld()
      addIdentity(world, 'owner')
      addCodeGen(world, 'owner', { identity: 'owner', slots: { cap: { methods: ['owner-m'] } } })
      addIdentity(world, 'prov')
      addCodeGen(world, 'prov', { identity: 'prov', implements: ['cap'] })
      return world
    }

    it('本包 methods[cap] 优先', () => {
      const world = worldWithProviderAndOwner()
      const decl = declOf({ identity: 'prov', methods: { cap: ['own-m'] } })
      expect(effectiveMethods(world, 'prov', decl, 'cap')).toEqual(['own-m'])
    })

    it('无 methods 时用本包 slots[cap]（拥有方自产自用）', () => {
      const world = worldWithProviderAndOwner()
      const decl = declOf({ identity: 'prov', slots: { cap: { methods: ['slot-m'] } } })
      expect(effectiveMethods(world, 'prov', decl, 'cap')).toEqual(['slot-m'])
    })

    it('两者都无时回落世界契约', () => {
      const world = worldWithProviderAndOwner()
      const decl = declOf({ identity: 'prov' })
      expect(effectiveMethods(world, 'prov', decl, 'cap')).toEqual(['owner-m'])
    })

    it('无任何契约 / 身份不在世界 → 空表', () => {
      const world = worldWithProviderAndOwner()
      const decl = declOf({ identity: 'prov' })
      expect(effectiveMethods(world, 'prov', decl, 'missing')).toEqual([])
      expect(effectiveMethods(world, 'ghost', decl, 'cap')).toEqual([])
    })
  })

  describe('缓存：就地演化与有界', () => {
    it('世界就地演化（不改 world.ids 引用）后索引随之刷新', () => {
      const world = emptyWorld()
      addIdentity(world, 'late')
      expect(capabilityProviders(world, 'cap')).toEqual([])
      addCodeGen(world, 'late', { identity: 'late', implements: ['cap'] })
      expect(capabilityProviders(world, 'cap')).toEqual(['late'])
      world.ids['late'].active = null
      expect(capabilityProviders(world, 'cap')).toEqual([])
    })

    it('声明读不出的失败不缓存：补齐 blob 后同世代可重算成功', () => {
      const world = emptyWorld()
      addIdentity(world, 'broken')
      const text = JSON.stringify(fullDecl({ identity: 'broken', implements: ['cap'] }))
      const jsonHash = H(text)
      const entries = [{ name: 'plugin.json', mode: 'file', hash: jsonHash }]
      const treeHash = H({ entries })
      const payload = H({ tree: treeHash })
      world.defs[treeHash] = { body: { entries } }
      world.defs[payload] = { body: { tree: treeHash }, sig: payload }
      world.ids['broken'].gens.push(genOf(world.ids['broken'], payload))
      world.ids['broken'].active = payload

      expect(capabilityProviders(world, 'cap')).toEqual([])
      world.defs[jsonHash] = { body: text }
      expect(capabilityProviders(world, 'cap')).toEqual(['broken'])
    })

    it('世代事实缓存有界：写入超过上限后条数不超过上限，索引仍完整', () => {
      const world = emptyWorld()
      const total = GEN_FACTS_CACHE_MAX + 16
      for (let i = 0; i < total; i++) {
        const id = `p${i}`
        addIdentity(world, id)
        addCodeGen(world, id, { identity: id, implements: ['cap'] })
        capabilityProviders(world, 'cap')
      }
      expect(capabilityFactsCacheSize()).toBeLessThanOrEqual(GEN_FACTS_CACHE_MAX)
      expect(capabilityProviders(world, 'cap')).toHaveLength(total)
    })
  })
})
