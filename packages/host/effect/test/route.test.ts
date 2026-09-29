import { describe, expect, it } from 'vitest'
import { H } from '../../../kernel/index.ts'
import { EndpointTable } from '../../endpoint-table.ts'
import { createRoundRouter } from '../route.ts'
import type { HostCapabilityCall } from '../route.ts'
import type { EndpointRow } from '../../endpoint-table.ts'
import type { Def, Gen, Hash, Identity, Json, World } from '../../../kernel/index.ts'

const SIG = 's'.repeat(64)
const CALLER_PAYLOAD = H({ body: { caller: true } })

const DECL: Json = {
  identity: 'dep',
  schema: 'schema/plugin.schema.json',
  implements: ['toy.echo'],
  methods: { 'toy.echo': ['echo'] },
  pins: {},
  start: 'node execute/main.js',
  build: [],
  protocol: '1',
  restart: { policy: 'on-exit' },
  health: { interval_ms: 0 },
  state: 'recomputable',
  members: [{ kind: 'execute', path: 'execute/' }],
  commands: [],
}

function commitOf(decl: Json, version: number): { payload: Hash; defs: Record<Hash, Def> } {
  const blob = H({ body: JSON.stringify(decl) })
  const treeBody: Json = { entries: [{ name: 'plugin.json', mode: 'file', hash: blob }] }
  const tree = H({ body: treeBody })
  const commitBody: Json = { tree, meta: { version } }
  const payload = H({ body: commitBody })
  return {
    payload,
    defs: {
      [blob]: { body: JSON.stringify(decl) },
      [tree]: { body: treeBody },
      [payload]: { body: commitBody },
    },
  }
}

const V1 = commitOf(DECL, 1)
const V2 = commitOf(DECL, 2)

function genOf(payload: Hash, pins: Record<string, Hash> = {}, seq = 0): Gen {
  return {
    seq,
    payload,
    pins,
    sig: SIG,
    adopted: { at: 1, by: 'seed', write: payload },
  }
}

function identityOf(id: string, gens: Gen[], active: Hash | null): Identity {
  return { id, schema: SIG, gens, active, born: { at: 1, by: 'seed' } }
}

/** caller（pins 可配） + dep（两世代，active 可配）的世界；dep 声明取 depCommit。 */
function makeWorld(
  callerPins: Record<string, Hash>,
  depActive: Hash | null = V2.payload,
  depCommit: { payload: Hash; defs: Record<Hash, Def> } = V2,
): World {
  const defs: Record<Hash, Def> = {
    ...V1.defs,
    ...depCommit.defs,
    [CALLER_PAYLOAD]: { body: { caller: true } },
  }
  return {
    defs,
    ids: {
      dep: identityOf(
        'dep',
        [genOf(V1.payload, {}, 0), genOf(depCommit.payload, {}, 1)],
        depActive,
      ),
      caller: identityOf('caller', [genOf(CALLER_PAYLOAD, callerPins)], CALLER_PAYLOAD),
    },
  }
}

function rowOf(impl: string, gen: Hash, cap: string, method: string): EndpointRow {
  return {
    impl,
    gen,
    cap,
    method,
    transport: 'stdio',
    pid: 1,
    link: { call: async () => ({ ok: true, value: null }) } as unknown as EndpointRow['link'],
  }
}

describe('A1 路由 createRoundRouter', () => {
  it('pins 名 → def → 属主身份 → 当前 active 世代 → 端点表行', () => {
    const world = makeWorld({ 'toy.echo': V2.payload })
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
    const drifts: string[] = []
    const outcome = createRoundRouter({ endpoints, onDrift: () => drifts.push('drift') }).resolve(
      world,
      'caller',
      'toy.echo',
      'echo',
    )
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.row.impl).toBe('dep')
      expect(outcome.row.gen).toBe(V2.payload)
    }
    // 无漂移时不记证据
    expect(drifts).toEqual([])
  })

  it('pins 无此名 / 发出者无 active → unresolved_cap', () => {
    const world = makeWorld({})
    const router = createRoundRouter({ endpoints: new EndpointTable() })
    expect(router.resolve(world, 'caller', 'nope', 'echo')).toEqual({
      ok: false,
      error: 'unresolved_cap',
    })
    world.ids['caller'] = identityOf(
      'caller',
      [genOf(CALLER_PAYLOAD, { 'toy.echo': V2.payload })],
      null,
    )
    expect(router.resolve(world, 'caller', 'toy.echo', 'echo')).toEqual({
      ok: false,
      error: 'unresolved_cap',
    })
  })

  it('pin 指向的 def 不在世界 / 属主缺失 → stale', () => {
    const ghost: Hash = 'z'.repeat(64)
    const world = makeWorld({ 'toy.echo': ghost })
    world.defs[ghost] = { body: {} } // def 在，但不属于任何身份世代
    expect(
      createRoundRouter({ endpoints: new EndpointTable() }).resolve(
        world,
        'caller',
        'toy.echo',
        'echo',
      ),
    ).toEqual({ ok: false, error: 'stale' })

    const absent = makeWorld({ 'toy.echo': 'y'.repeat(64) })
    expect(
      createRoundRouter({ endpoints: new EndpointTable() }).resolve(
        absent,
        'caller',
        'toy.echo',
        'echo',
      ),
    ).toEqual({ ok: false, error: 'stale' })
  })

  it('依赖 retired（active=null）→ stale，绝不回落旧世代', () => {
    const world = makeWorld({ 'toy.echo': V1.payload }, null)
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('dep', V1.payload, 'toy.echo', 'echo'))
    expect(createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')).toEqual({
      ok: false,
      error: 'stale',
    })
  })

  it('cap 不在依赖声明的能力类 → not_loaded', () => {
    const decl: Json = { ...(DECL as Record<string, Json>), implements: ['other.cap'] }
    const alt = commitOf(decl, 2)
    const world = makeWorld({ 'toy.echo': alt.payload }, alt.payload, alt)
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('dep', alt.payload, 'toy.echo', 'echo'))
    expect(createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')).toEqual({
      ok: false,
      error: 'not_loaded',
    })
  })

  it('端点表无此行 → not_loaded', () => {
    const world = makeWorld({ 'toy.echo': V2.payload })
    expect(
      createRoundRouter({ endpoints: new EndpointTable() }).resolve(
        world,
        'caller',
        'toy.echo',
        'echo',
      ),
    ).toEqual({ ok: false, error: 'not_loaded' })
  })

  it('绝不回落旧世代：pin=新 active、端点表只有旧世代行 → not_loaded', () => {
    const world = makeWorld({ 'toy.echo': V2.payload })
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('dep', V1.payload, 'toy.echo', 'echo'))
    expect(createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')).toEqual({
      ok: false,
      error: 'not_loaded',
    })
  })

  it('pin 世代 ≠ 依赖当前 active：解析到新 active 行 + 记漂移证据', () => {
    const world = makeWorld({ 'toy.echo': V1.payload })
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
    const drifts: string[] = []
    const router = createRoundRouter({
      endpoints,
      onDrift: (emitter, cap) => drifts.push(`${emitter}:${cap}`),
    })
    const outcome = router.resolve(world, 'caller', 'toy.echo', 'echo')
    expect(outcome.ok).toBe(true)
    if (outcome.ok) expect(outcome.row.gen).toBe(V2.payload)
    expect(drifts).toEqual(['caller:toy.echo'])
  })

  describe('保留能力类 host', () => {
    const hostPinWorld = (): World => makeWorld({ host: 'host' })

    it('pin 值为 host：已知方法返回宿主端点行，不查世界 / 端点表', async () => {
      const world = hostPinWorld()
      const calls: Array<{ method: string; emitter: string; args: Json }> = []
      const host: HostCapabilityCall = async (method, emitter, args) => {
        calls.push({ method, emitter, args })
        return { ok: true, value: { records: [], truncated: false } }
      }
      const router = createRoundRouter({ endpoints: new EndpointTable(), host })
      const outcome = router.resolve(world, 'caller', 'host', 'audit')
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.row).toMatchObject({
        impl: 'host',
        gen: 'host',
        cap: 'host',
        method: 'audit',
        transport: 'host',
        pid: 0,
      })
      const response = await outcome.row.link.call('host', 'audit', { limit: 1 }, 1000)
      expect(response).toEqual({ ok: true, value: { records: [], truncated: false } })
      expect(calls).toEqual([{ method: 'audit', emitter: 'caller', args: { limit: 1 } }])
    })

    it('未知方法 / 非 host cap → not_loaded', () => {
      const world = hostPinWorld()
      const host: HostCapabilityCall = async () => ({ ok: true, value: null })
      const router = createRoundRouter({ endpoints: new EndpointTable(), host })
      expect(router.resolve(world, 'caller', 'host', 'nope')).toEqual({
        ok: false,
        error: 'not_loaded',
      })
      // pin 值 host 但 pin 名（调用点 cap）不是 host：不路由
      const aliased = makeWorld({ audit: 'host' })
      expect(router.resolve(aliased, 'caller', 'audit', 'audit')).toEqual({
        ok: false,
        error: 'not_loaded',
      })
    })

    it('未接线宿主派发器 → not_loaded', () => {
      const world = hostPinWorld()
      const router = createRoundRouter({ endpoints: new EndpointTable() })
      expect(router.resolve(world, 'caller', 'host', 'audit')).toEqual({
        ok: false,
        error: 'not_loaded',
      })
    })
  })

  describe('自能力路由（无自 pin）', () => {
    const SOLO_DECL: Json = { ...(DECL as Record<string, Json>), identity: 'solo' }
    const SOLO = commitOf(SOLO_DECL, 1)

    function soloWorld(
      soloPins: Record<string, Hash> = {},
      active: Hash | null = SOLO.payload,
    ): World {
      return {
        defs: { ...SOLO.defs },
        ids: { solo: identityOf('solo', [genOf(SOLO.payload, soloPins, 0)], active) },
      }
    }

    it('未 pin、自身 implements 含该能力类 → 解析到自己的端点行并可调用', async () => {
      const world = soloWorld()
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('solo', SOLO.payload, 'toy.echo', 'echo'))
      const outcome = createRoundRouter({ endpoints }).resolve(world, 'solo', 'toy.echo', 'echo')
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.row.impl).toBe('solo')
      expect(outcome.row.gen).toBe(SOLO.payload)
      expect(await outcome.row.link.call('toy.echo', 'echo', null, 1000)).toEqual({
        ok: true,
        value: null,
      })
    })

    it('显式 pin 优先于自能力：pin 指向另一身份时解析到被依赖者', () => {
      const world: World = {
        defs: { ...V2.defs, ...SOLO.defs },
        ids: {
          dep: identityOf('dep', [genOf(V2.payload, {}, 0)], V2.payload),
          solo: identityOf(
            'solo',
            [genOf(SOLO.payload, { 'toy.echo': V2.payload }, 0)],
            SOLO.payload,
          ),
        },
      }
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('solo', SOLO.payload, 'toy.echo', 'echo'))
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      const outcome = createRoundRouter({ endpoints }).resolve(world, 'solo', 'toy.echo', 'echo')
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.row.impl).toBe('dep')
    })

    it('未 pin 且自身未声明该能力类 → unresolved_cap（与旧行为一致）', () => {
      const world = soloWorld()
      const router = createRoundRouter({ endpoints: new EndpointTable() })
      expect(router.resolve(world, 'solo', 'other.cap', 'x')).toEqual({
        ok: false,
        error: 'unresolved_cap',
      })
    })

    it('自身声明了该能力类但端点行缺失 → not_loaded', () => {
      const world = soloWorld()
      expect(
        createRoundRouter({ endpoints: new EndpointTable() }).resolve(
          world,
          'solo',
          'toy.echo',
          'echo',
        ),
      ).toEqual({ ok: false, error: 'not_loaded' })
    })

    it('保留能力类 host 不走自能力：未显式 pin 值 host 仍 unresolved_cap', () => {
      const decl: Json = { ...(SOLO_DECL as Record<string, Json>), implements: ['host'] }
      const host = commitOf(decl, 1)
      const world: World = {
        defs: { ...host.defs },
        ids: { solo: identityOf('solo', [genOf(host.payload, {}, 0)], host.payload) },
      }
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('solo', host.payload, 'host', 'audit'))
      expect(createRoundRouter({ endpoints }).resolve(world, 'solo', 'host', 'audit')).toEqual({
        ok: false,
        error: 'unresolved_cap',
      })
    })
  })

  describe('A1 路由缓存与世代偏斜', () => {
    it('声明读不出不缓存 null：补齐 def 后同世界重试成功', () => {
      const world = makeWorld({ 'toy.echo': V2.payload })
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      const router = createRoundRouter({ endpoints })
      const blob = H({ body: JSON.stringify(DECL) })
      const saved = world.defs[blob]
      delete world.defs[blob]
      expect(router.resolve(world, 'caller', 'toy.echo', 'echo')).toEqual({
        ok: false,
        error: 'not_loaded',
      })
      world.defs[blob] = saved
      expect(router.resolve(world, 'caller', 'toy.echo', 'echo').ok).toBe(true)
    })

    it('liveWorld：解析世界与活端点表同代，消除锚定旧世代偏斜', () => {
      const anchored = makeWorld({ 'toy.echo': V1.payload }, V1.payload, V1)
      const live = makeWorld({ 'toy.echo': V1.payload }, V2.payload, V2)
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      // 不注入 liveWorld：锚定世界 dep.active=V1，端点表只有 V2 行 → not_loaded
      expect(
        createRoundRouter({ endpoints }).resolve(anchored, 'caller', 'toy.echo', 'echo'),
      ).toEqual({ ok: false, error: 'not_loaded' })
      // 注入 liveWorld：解析按活世界 dep.active=V2 → 命中 V2 行
      const routed = createRoundRouter({ endpoints, liveWorld: () => live }).resolve(
        anchored,
        'caller',
        'toy.echo',
        'echo',
      )
      expect(routed.ok).toBe(true)
      if (routed.ok) expect(routed.row.gen).toBe(V2.payload)
    })

    it('resolutionWorld：暴露路由采用的解析世界，与 liveWorld 同源', () => {
      const anchored = makeWorld({ 'toy.echo': V1.payload }, V1.payload, V1)
      const live = makeWorld({ 'toy.echo': V1.payload }, V2.payload, V2)
      const router = createRoundRouter({
        endpoints: new EndpointTable(),
        liveWorld: () => live,
      })
      expect(router.resolutionWorld?.(anchored)).toBe(live)
      // 未注入 liveWorld：解析世界 = 传入的锚定世界
      const plain = createRoundRouter({ endpoints: new EndpointTable() })
      expect(plain.resolutionWorld?.(anchored)).toBe(anchored)
    })
  })

  describe('one 需求绑定路由（commit.body.meta.needs）', () => {
    const CALLER_DECL: Json = {
      ...(DECL as Record<string, Json>),
      identity: 'caller',
      implements: [],
      methods: {},
    }

    function commitWithMeta(decl: Json, meta: Json): { payload: Hash; defs: Record<Hash, Def> } {
      const blob = H({ body: JSON.stringify(decl) })
      const treeBody: Json = { entries: [{ name: 'plugin.json', mode: 'file', hash: blob }] }
      const tree = H({ body: treeBody })
      const commitBody: Json = { tree, meta }
      const payload = H({ body: commitBody })
      return {
        payload,
        defs: {
          [blob]: { body: JSON.stringify(decl) },
          [tree]: { body: treeBody },
          [payload]: { body: commitBody },
        },
      }
    }

    function callerWorld(
      callerPayload: Hash,
      callerDefs: Record<Hash, Def>,
      depActive: Hash | null = V2.payload,
    ): World {
      return {
        defs: { ...V1.defs, ...V2.defs, ...callerDefs },
        ids: {
          dep: identityOf('dep', [genOf(V2.payload, {}, 0)], depActive),
          caller: identityOf('caller', [genOf(callerPayload, {}, 0)], callerPayload),
        },
      }
    }

    it('绑定身份名 → 解析到绑定提供方端点', () => {
      const caller = commitWithMeta(CALLER_DECL, { version: 1, needs: { 'toy.echo': 'dep' } })
      const world = callerWorld(caller.payload, caller.defs)
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      const outcome = createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.row.impl).toBe('dep')
    })

    it('绑定提供方退役（active=null）→ stale', () => {
      const caller = commitWithMeta(CALLER_DECL, { version: 1, needs: { 'toy.echo': 'dep' } })
      const world = callerWorld(caller.payload, caller.defs, null)
      expect(
        createRoundRouter({ endpoints: new EndpointTable() }).resolve(
          world,
          'caller',
          'toy.echo',
          'echo',
        ),
      ).toEqual({ ok: false, error: 'stale' })
    })

    it('绑定提供方不声明该能力类 → not_loaded', () => {
      const altDecl: Json = { ...(DECL as Record<string, Json>), implements: ['other.cap'] }
      const alt = commitOf(altDecl, 2)
      const caller = commitWithMeta(CALLER_DECL, { version: 1, needs: { 'toy.echo': 'dep' } })
      const world: World = {
        defs: { ...alt.defs, ...caller.defs },
        ids: {
          dep: identityOf('dep', [genOf(alt.payload, {}, 0)], alt.payload),
          caller: identityOf('caller', [genOf(caller.payload, {}, 0)], caller.payload),
        },
      }
      expect(
        createRoundRouter({ endpoints: new EndpointTable() }).resolve(
          world,
          'caller',
          'toy.echo',
          'echo',
        ),
      ).toEqual({ ok: false, error: 'not_loaded' })
    })

    it('绑定换代：活跃世代指向新提供方 → 解析到新提供方', () => {
      const dep2Decl: Json = { ...(DECL as Record<string, Json>), identity: 'dep2' }
      const dep2 = commitOf(dep2Decl, 2)
      const first = commitWithMeta(CALLER_DECL, { version: 0, needs: { 'toy.echo': 'dep' } })
      const second = commitWithMeta(CALLER_DECL, { version: 1, needs: { 'toy.echo': 'dep2' } })
      const world: World = {
        defs: { ...V2.defs, ...dep2.defs, ...first.defs, ...second.defs },
        ids: {
          dep: identityOf('dep', [genOf(V2.payload, {}, 0)], V2.payload),
          dep2: identityOf('dep2', [genOf(dep2.payload, {}, 0)], dep2.payload),
          caller: identityOf(
            'caller',
            [genOf(first.payload, {}, 0), genOf(second.payload, {}, 1)],
            second.payload,
          ),
        },
      }
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      endpoints.add(rowOf('dep2', dep2.payload, 'toy.echo', 'echo'))
      const outcome = createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.row.impl).toBe('dep2')
    })

    it('优先级：显式 pins > meta.needs', () => {
      const dep2Decl: Json = { ...(DECL as Record<string, Json>), identity: 'dep2' }
      const dep2 = commitOf(dep2Decl, 2)
      const caller = commitWithMeta(CALLER_DECL, { version: 1, needs: { 'toy.echo': 'dep2' } })
      const world: World = {
        defs: { ...V2.defs, ...dep2.defs, ...caller.defs },
        ids: {
          dep: identityOf('dep', [genOf(V2.payload, {}, 0)], V2.payload),
          dep2: identityOf('dep2', [genOf(dep2.payload, {}, 0)], dep2.payload),
          caller: identityOf(
            'caller',
            [genOf(caller.payload, { 'toy.echo': V2.payload }, 0)],
            caller.payload,
          ),
        },
      }
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      endpoints.add(rowOf('dep2', dep2.payload, 'toy.echo', 'echo'))
      const outcome = createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.row.impl).toBe('dep')
    })

    it('优先级：meta.needs > 自能力路径（无 pins 时）', () => {
      // 声明期已禁同一能力类既 implements 又 needs；此处只验路由的优先级分支
      const selfDecl: Json = { ...(DECL as Record<string, Json>), identity: 'caller' }
      const caller = commitWithMeta(selfDecl, { version: 1, needs: { 'toy.echo': 'dep' } })
      const world = callerWorld(caller.payload, caller.defs)
      const endpoints = new EndpointTable()
      endpoints.add(rowOf('caller', caller.payload, 'toy.echo', 'echo'))
      endpoints.add(rowOf('dep', V2.payload, 'toy.echo', 'echo'))
      const outcome = createRoundRouter({ endpoints }).resolve(world, 'caller', 'toy.echo', 'echo')
      expect(outcome.ok).toBe(true)
      if (outcome.ok) expect(outcome.row.impl).toBe('dep')
    })
  })
})

describe('槽解析 resolveSlot（many）', () => {
  const CALLER_DECL: Json = {
    ...(DECL as Record<string, Json>),
    identity: 'caller',
    implements: [],
    methods: {},
  }

  /** 带 `needs` 的消费方世界：`providers` 各自声明 `toy.echo`，caller 声明其 needs。 */
  function manyWorld(
    providerIds: string[],
    needs: Json = { 'toy.echo': { mode: 'many' } },
    retiredProviders: string[] = [],
  ): World {
    const defs: Record<Hash, Def> = {}
    const ids: World['ids'] = {}
    for (const id of providerIds) {
      const commit = commitOf({ ...(DECL as Record<string, Json>), identity: id }, 1)
      Object.assign(defs, commit.defs)
      ids[id] = identityOf(id, [genOf(commit.payload, {}, 0)], commit.payload)
    }
    for (const id of retiredProviders) {
      const commit = commitOf({ ...(DECL as Record<string, Json>), identity: id }, 1)
      Object.assign(defs, commit.defs)
      ids[id] = identityOf(id, [genOf(commit.payload, {}, 0)], null)
    }
    const caller = commitOf({ ...(CALLER_DECL as Record<string, Json>), needs }, 1)
    Object.assign(defs, caller.defs)
    ids['caller'] = identityOf('caller', [genOf(caller.payload, {}, 0)], caller.payload)
    return { defs, ids }
  }

  function assemblyGenOf(id: string, world: World): Hash {
    const gens = world.ids[id].gens
    return gens[gens.length - 1].payload
  }

  it('未声明该 cap / mode:"one" / 发出者无装配世代 → null', () => {
    const router = createRoundRouter({ endpoints: new EndpointTable() })
    expect(router.resolveSlot?.(manyWorld(['a']), 'caller', 'nope', 'echo')).toBeNull()
    const one = manyWorld(['a'], { 'toy.echo': { mode: 'one' } })
    expect(router.resolveSlot?.(one, 'caller', 'toy.echo', 'echo')).toBeNull()
    const retiredCaller = manyWorld(['a'])
    retiredCaller.ids['caller'] = identityOf('caller', [], null)
    expect(router.resolveSlot?.(retiredCaller, 'caller', 'toy.echo', 'echo')).toBeNull()
  })

  it('many：成员按提供方身份名码元序，1 命中解析到端点行', () => {
    const world = manyWorld(['b', 'a'])
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('a', assemblyGenOf('a', world), 'toy.echo', 'echo'))
    endpoints.add(rowOf('b', assemblyGenOf('b', world), 'toy.echo', 'echo'))
    const outcome = createRoundRouter({ endpoints }).resolveSlot?.(
      world,
      'caller',
      'toy.echo',
      'echo',
    )
    expect(outcome?.members.map((member) => member.provider)).toEqual(['a', 'b'])
    const [first, second] = outcome?.members ?? []
    expect(first.ok && first.row.impl).toBe('a')
    expect(second.ok && second.row.impl).toBe('b')
  })

  it('成员缺端点行 → 该元素 not_loaded，其余成员不受影响', () => {
    const world = manyWorld(['a', 'b'])
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('a', assemblyGenOf('a', world), 'toy.echo', 'echo'))
    const outcome = createRoundRouter({ endpoints }).resolveSlot?.(
      world,
      'caller',
      'toy.echo',
      'echo',
    )
    expect(outcome?.members).toEqual([
      { provider: 'a', ok: true, row: expect.objectContaining({ impl: 'a' }) },
      { provider: 'b', ok: false, error: 'not_loaded' },
    ])
  })

  it('0 命中 → 空成员表（合法）', () => {
    const outcome = createRoundRouter({ endpoints: new EndpointTable() }).resolveSlot?.(
      manyWorld([]),
      'caller',
      'toy.echo',
      'echo',
    )
    expect(outcome).toEqual({ members: [] })
  })

  it('退役提供方静默缺席（不入成员表）', () => {
    const world = manyWorld(['a'], undefined, ['gone'])
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('a', assemblyGenOf('a', world), 'toy.echo', 'echo'))
    const outcome = createRoundRouter({ endpoints }).resolveSlot?.(
      world,
      'caller',
      'toy.echo',
      'echo',
    )
    expect(outcome?.members.map((member) => member.provider)).toEqual(['a'])
  })
})
