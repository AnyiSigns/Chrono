import { describe, expect, it } from 'vitest'
import { H } from '../../../kernel/index.ts'
import { EndpointTable } from '../../endpoint-table.ts'
import { createRoundRouter } from '../route.ts'
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
})
