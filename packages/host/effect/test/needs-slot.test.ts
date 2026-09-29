// 能力需求的运行相不变量：`many` 成员集随世界提供方增减（消费方声明不变）；
// 休眠（端点行缺失）成员作元素错误、聚合仍 ok；提供方退役不连坐消费方其余能力调用；
// 同世界同返回的聚合 `canonicalJson` 相同。

import { afterEach, describe, expect, it } from 'vitest'
import { H, canonicalJson } from '../../../kernel/index.ts'
import { EndpointTable } from '../../endpoint-table.ts'
import { WorldWriter } from '../../writer.ts'
import { resetFatal } from '../fatal.ts'
import { createRoundRouter } from '../route.ts'
import { runRound } from '../run-loop.ts'
import type { AuditDraft } from '../../audit.ts'
import type { EndpointCallResult, EndpointRow } from '../../endpoint-table.ts'
import type { Def, Directive, Gen, Hash, Identity, Json, World } from '../../../kernel/index.ts'

afterEach(() => {
  resetFatal()
})

const SIG = 's'.repeat(64)
const LIMITS = { gas: 1_000_000, depth: 64 }

function decl(identity: string, overrides: Record<string, Json> = {}): Json {
  return {
    identity,
    schema: 'schema/plugin.schema.json',
    implements: [],
    methods: {},
    pins: {},
    start: '',
    build: [],
    protocol: '1',
    restart: { policy: 'never' },
    health: { interval_ms: 0 },
    state: 'recomputable',
    members: [],
    commands: [],
    ...overrides,
  }
}

/** 一份声明 → 代码世代 commit defs（tree → plugin.json blob）；`meta` 写进 commit.body.meta。 */
function commitOf(body: Json, meta?: Json): { payload: Hash; defs: Record<Hash, Def> } {
  const blob = H({ body: JSON.stringify(body) })
  const treeBody: Json = { entries: [{ name: 'plugin.json', mode: 'file', hash: blob }] }
  const tree = H({ body: treeBody })
  const commitBody: Json = meta === undefined ? { tree } : { tree, meta }
  const payload = H({ body: commitBody })
  return {
    payload,
    defs: {
      [blob]: { body: JSON.stringify(body) },
      [tree]: { body: treeBody },
      [payload]: { body: commitBody },
    },
  }
}

function genOf(payload: Hash): Gen {
  return { seq: 0, payload, pins: {}, sig: SIG, adopted: { at: 1, by: 'seed', write: payload } }
}

function identityOf(id: string, payload: Hash, active: Hash | null = payload): Identity {
  return { id, schema: SIG, gens: [genOf(payload)], active, born: { at: 1, by: 'seed' } }
}

const MANY_PROVIDER = (id: string): Json =>
  decl(id, { implements: ['cap.many'], methods: { 'cap.many': ['collect'] } })

const CONSUMER_MANY = decl('consumer', {
  needs: { 'cap.many': { mode: 'many', methods: ['collect'] } },
})

/** 消费方 + 各提供方的世界；`consumer` 传入同一 commit 以证明跨世界声明逐字节未变。 */
function manyWorld(
  providers: string[],
  consumer: { payload: Hash; defs: Record<Hash, Def> },
  retired: string[] = [],
): World {
  const defs: Record<Hash, Def> = { ...consumer.defs }
  const ids: World['ids'] = { consumer: identityOf('consumer', consumer.payload) }
  for (const id of providers) {
    const c = commitOf(MANY_PROVIDER(id))
    Object.assign(defs, c.defs)
    ids[id] = identityOf(id, c.payload)
  }
  for (const id of retired) {
    const c = commitOf(MANY_PROVIDER(id))
    Object.assign(defs, c.defs)
    ids[id] = identityOf(id, c.payload, null)
  }
  return { defs, ids }
}

function assemblyGenOf(id: string, world: World): Hash {
  const gens = world.ids[id].gens
  return gens[gens.length - 1].payload
}

function membersOf(world: World): string[] {
  const outcome = createRoundRouter({ endpoints: new EndpointTable() }).resolveSlot?.(
    world,
    'consumer',
    'cap.many',
    'collect',
  )
  return (outcome?.members ?? []).map((member) => member.provider)
}

function rowOf(impl: string, gen: Hash, cap: string, method: string, value: Json): EndpointRow {
  return {
    impl,
    gen,
    cap,
    method,
    transport: 'stdio',
    pid: 1,
    link: {
      call: async (): Promise<EndpointCallResult> => ({ ok: true, value }),
    } as unknown as EndpointRow['link'],
  }
}

const TERM: Hash = 'th'.repeat(32)

function evalDirective(): Directive {
  return { kind: 'eval', entry: TERM, args: null, ctx: null }
}

describe('能力需求 needs：many 成员随世界跟随', () => {
  it('增删提供方改变成员集，消费方声明 commit 逐字节不变', () => {
    const consumer = commitOf(CONSUMER_MANY)
    const w2 = manyWorld(['prov-a', 'prov-b'], consumer)
    const w3 = manyWorld(['prov-a', 'prov-b', 'prov-c'], consumer)

    expect(membersOf(w2)).toEqual(['prov-a', 'prov-b'])
    expect(membersOf(w3)).toEqual(['prov-a', 'prov-b', 'prov-c'])
    // 同一消费方 commit 复用到两世界：成员集差异只来自世界提供方集合。
    expect(w2.ids['consumer'].gens[0].payload).toBe(consumer.payload)
    expect(w3.ids['consumer'].gens[0].payload).toBe(consumer.payload)
  })

  it('退役提供方静默缺席（既非成员、也无元素错误）', () => {
    const consumer = commitOf(CONSUMER_MANY)
    const world = manyWorld(['prov-a', 'prov-b', 'prov-c'], consumer, ['prov-b'])
    expect(membersOf(world)).toEqual(['prov-a', 'prov-c'])
  })

  it('休眠提供方（端点行缺失）仍是成员并作元素错误；整体聚合仍 ok:true', async () => {
    const consumer = commitOf(CONSUMER_MANY)
    const world = manyWorld(['prov-a', 'prov-b'], consumer)
    world.defs[TERM] = { body: ['eff', 'cap.many', 'collect', ['v', 0]] }
    // 只给 a 端点行：b 模拟休眠（世界声明在、端点行缺失）。
    const endpoints = new EndpointTable()
    endpoints.add(
      rowOf('prov-a', assemblyGenOf('prov-a', world), 'cap.many', 'collect', { from: 'prov-a' }),
    )
    const router = createRoundRouter({ endpoints })
    const audits: AuditDraft[] = []
    const outcome = await runRound({
      writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
      directives: [evalDirective()],
      owners: ['consumer'],
      caps: {},
      limits: LIMITS,
      initiator: 'e2e',
      now: 1,
      router,
      onAudit: (draft) => audits.push(draft),
    })
    expect(outcome.status).toBe('done')
    expect(outcome.observations).toEqual([
      {
        kind: 'eval',
        entry: TERM,
        ok: true,
        value: [
          { provider: 'prov-a', ok: true, value: { from: 'prov-a' } },
          { provider: 'prov-b', ok: false, error: 'not_loaded' },
        ],
      },
    ])
    // 元素失败只体现在审计 outcome；聚合 EffResult 仍 ok:true。
    const body = audits[0].body as unknown as { outcome: string }
    expect(body.outcome).toBe('error')
  })

  it('同世界同返回：两次聚合 canonicalJson 相同', async () => {
    const consumer = commitOf(CONSUMER_MANY)
    const world = manyWorld(['prov-a', 'prov-b'], consumer)
    world.defs[TERM] = { body: ['eff', 'cap.many', 'collect', ['v', 0]] }
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('prov-a', assemblyGenOf('prov-a', world), 'cap.many', 'collect', 'a'))
    endpoints.add(rowOf('prov-b', assemblyGenOf('prov-b', world), 'cap.many', 'collect', 'b'))
    const router = createRoundRouter({ endpoints })

    const once = async (): Promise<Json> => {
      const outcome = await runRound({
        writer: new WorldWriter({ world, head: { seq: -1, hash: null } }),
        directives: [evalDirective()],
        owners: ['consumer'],
        caps: {},
        limits: LIMITS,
        initiator: 'e2e',
        now: 1,
        router,
      })
      expect(outcome.status).toBe('done')
      return outcome.observations
    }
    expect(canonicalJson(await once())).toBe(canonicalJson(await once()))
  })
})

describe('能力需求 needs：提供方退役不连坐消费方', () => {
  it('消费方其余能力调用照常；仅绑定的 one cap 得 stale', () => {
    const consumerCommit = commitOf(
      decl('consumer', {
        implements: ['self.cap'],
        methods: { 'self.cap': ['ping'] },
        needs: { 'cap.one': { mode: 'one' } },
      }),
      { needs: { 'cap.one': 'prov-a' } },
    )
    const providerCommit = commitOf(
      decl('prov-a', { implements: ['cap.one'], methods: { 'cap.one': ['get'] } }),
    )
    const world: World = {
      defs: { ...consumerCommit.defs, ...providerCommit.defs },
      ids: {
        consumer: identityOf('consumer', consumerCommit.payload),
        'prov-a': identityOf('prov-a', providerCommit.payload),
      },
    }
    const consumerGen = assemblyGenOf('consumer', world)
    const endpoints = new EndpointTable()
    endpoints.add(rowOf('consumer', consumerGen, 'self.cap', 'ping', 'pong'))
    endpoints.add(rowOf('prov-a', assemblyGenOf('prov-a', world), 'cap.one', 'get', 'bound'))
    const router = createRoundRouter({ endpoints })

    expect(router.resolve(world, 'consumer', 'self.cap', 'ping').ok).toBe(true)
    expect(router.resolve(world, 'consumer', 'cap.one', 'get').ok).toBe(true)

    world.ids['prov-a'].active = null
    // 提供方退役：消费方自身能力照常，绑定 cap 才 stale。
    expect(router.resolve(world, 'consumer', 'self.cap', 'ping').ok).toBe(true)
    expect(router.resolve(world, 'consumer', 'cap.one', 'get')).toEqual({
      ok: false,
      error: 'stale',
    })
  })
})
