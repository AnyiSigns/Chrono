// 入站三路（submit / command / forward）的 caps / limits 形状收口：
// 缺省回落默认、形状非法回 bad_directive 且不进 run；显式合法 budget 须真实生效（gas / depth 护栏）。

import { describe, expect, it } from 'vitest'
import type { Socket } from 'node:net'
import { EMPTY_HEAD, H } from '../../../kernel/index.ts'
import type { Json, World } from '../../../kernel/index.ts'
import { WorldWriter } from '../../writer.ts'
import { RunRegistry } from '../../run-registry.ts'
import { createInboundHandlers } from '../handlers.ts'
import type { RunDriverDeps } from '../handlers.ts'
import type { CommandDecl, CommandIndex } from '../../assembly/index.ts'
import type { InboundMessage, OutboundMessage } from '../../wire.ts'

/** 3 节点 / 深度 2：gas:1 必耗尽、gas:5 通过。 */
const ARITH: Json = ['arith', 'add', ['c', 1], ['c', 2]]
/** 深度 3：depth:2 必拒、默认 depth 通过。 */
const NESTED: Json = ['list', [['list', [['c', 1]]]]]

const ARITH_ENTRY = H(ARITH)
const NESTED_ENTRY = H(NESTED)

type SubmitMessage = Extract<InboundMessage, { kind: 'submit' }>
type CommandMessage = Extract<InboundMessage, { kind: 'command' }>
type ForwardMessage = Extract<InboundMessage, { kind: 'forward' }>

/** 收口测试可传任意 raw caps / limits（含畸形），不受线格式的窄类型约束。 */
type RawScope = { caps?: unknown; limits?: unknown }
type SubmitOverrides = Partial<Omit<SubmitMessage, 'caps' | 'limits'>> & RawScope
type CommandOverrides = Partial<Omit<CommandMessage, 'caps' | 'limits'>> & RawScope
type ForwardOverrides = Partial<Omit<ForwardMessage, 'caps' | 'limits'>> & RawScope

const SOCKET = {} as Socket
const SIGNAL = new AbortController().signal

function worldWithEntry(entry: string, term: Json): World {
  return { defs: { [entry]: { body: term } }, ids: {} }
}

function commandFor(entry: string): CommandDecl {
  return { identity: 'plugin.a', name: 'run', entry, argsSchema: null, readonly: false }
}

function indexOf(commands: CommandDecl[]): CommandIndex {
  const byName = new Map<string, CommandDecl>()
  for (const command of commands) byName.set(command.name, command)
  return { commands, byName }
}

interface Harness {
  handlers: ReturnType<typeof createInboundHandlers>
  frames: OutboundMessage[]
  events: string[]
}

function harness(world: World, commands: CommandDecl[] = []): Harness {
  const frames: OutboundMessage[] = []
  const events: string[] = []
  const deps: RunDriverDeps = {
    writer: new WorldWriter({ world, head: { ...EMPTY_HEAD } }),
    registry: new RunRegistry(1000),
    send: (_socket, message) => {
      frames.push(message)
    },
    getRouter: () => undefined,
    commandIndexFor: () => indexOf(commands),
    cachedProjection: () => ({}),
    persistAudit: () => undefined,
    persistRound: () => undefined,
    applyWorldSerial: async () => undefined,
    broadcast: (_impl, topic) => {
      events.push(topic)
    },
    safeAppendLifecycle: () => undefined,
    escalateFatal: () => undefined,
  }
  return { handlers: createInboundHandlers(deps), frames, events }
}

function errorFrames(frames: OutboundMessage[]): Extract<OutboundMessage, { kind: 'error' }>[] {
  return frames.filter(
    (frame): frame is Extract<OutboundMessage, { kind: 'error' }> => frame.kind === 'error',
  )
}

function resultFrames(frames: OutboundMessage[]): Extract<OutboundMessage, { kind: 'result' }>[] {
  return frames.filter(
    (frame): frame is Extract<OutboundMessage, { kind: 'result' }> => frame.kind === 'result',
  )
}

function submitMessage(overrides: SubmitOverrides): SubmitMessage {
  return { v: '1', id: 'm1', kind: 'submit', directives: [], ...overrides } as SubmitMessage
}

async function runSubmit(overrides: SubmitOverrides, entry: string): Promise<Harness> {
  const app = harness(worldWithEntry(entry, entry === ARITH_ENTRY ? ARITH : NESTED))
  await app.handlers.submit(
    SOCKET,
    submitMessage(overrides),
    [{ kind: 'eval', entry, args: null }],
    'r1',
    null,
    SIGNAL,
  )
  return app
}

describe('submit：caps / limits 缺省与合法值', () => {
  it('缺省 limits → 用默认预算且 run 正常', async () => {
    const app = await runSubmit({}, ARITH_ENTRY)
    expect(errorFrames(app.frames)).toHaveLength(0)
    expect(resultFrames(app.frames)[0]?.status).toBe('done')
    expect(app.events).toEqual(['run.started', 'run.finished'])
  })

  it('limits:{} 回落默认成功（非拒绝）', async () => {
    const app = await runSubmit({ limits: {} }, ARITH_ENTRY)
    expect(errorFrames(app.frames)).toHaveLength(0)
    expect(resultFrames(app.frames)[0]?.status).toBe('done')
  })

  it('caps 缺省 / caps:{} / 合法布尔表均放行', async () => {
    for (const caps of [undefined, {}, { a: true, b: false }]) {
      const app = await runSubmit({ caps }, ARITH_ENTRY)
      expect(errorFrames(app.frames)).toHaveLength(0)
      expect(resultFrames(app.frames)[0]?.status).toBe('done')
    }
  })
})

describe('submit：显式 budget 真实生效', () => {
  it('limits:{gas:5,depth:2} 通过', async () => {
    const app = await runSubmit({ limits: { gas: 5, depth: 2 } }, ARITH_ENTRY)
    expect(resultFrames(app.frames)[0]?.status).toBe('done')
  })

  it('limits:{gas:1} 使 gas 护栏生效 → refused', async () => {
    const app = await runSubmit({ limits: { gas: 1 } }, ARITH_ENTRY)
    expect(resultFrames(app.frames)[0]?.status).toBe('refused')
  })

  it('limits:{depth:2} 使 depth 护栏生效 → refused', async () => {
    const app = await runSubmit({ limits: { depth: 2 } }, NESTED_ENTRY)
    expect(resultFrames(app.frames)[0]?.status).toBe('refused')
  })

  it('边界：limits:{gas:1,depth:1} 单节点合法', async () => {
    const single: Json = ['c', 1]
    const entry = H(single)
    const app = harness(worldWithEntry(entry, single))
    await app.handlers.submit(
      SOCKET,
      submitMessage({ limits: { gas: 1, depth: 1 } }),
      [{ kind: 'eval', entry, args: null }],
      'r1',
      null,
      SIGNAL,
    )
    expect(resultFrames(app.frames)[0]?.status).toBe('done')
  })
})

describe('submit：畸形 caps / limits fail-closed', () => {
  const badLimits: unknown[] = [
    { gas: 0 },
    { depth: -1 },
    { gas: 1.5 },
    { gas: Number.NaN },
    { gas: Number.POSITIVE_INFINITY },
    'x',
    [],
    null,
  ]
  const badCaps: unknown[] = [[], null, { a: 'yes' }]

  it('畸形 limits → error{bad_directive}，不进 run', async () => {
    for (const limits of badLimits) {
      const app = await runSubmit({ limits }, ARITH_ENTRY)
      const errors = errorFrames(app.frames)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.code).toBe('bad_directive')
      expect(resultFrames(app.frames)).toHaveLength(0)
      expect(app.events).toEqual([])
    }
  })

  it('畸形 caps → error{bad_directive}，不进 run', async () => {
    for (const caps of badCaps) {
      const app = await runSubmit({ caps }, ARITH_ENTRY)
      const errors = errorFrames(app.frames)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.code).toBe('bad_directive')
      expect(resultFrames(app.frames)).toHaveLength(0)
      expect(app.events).toEqual([])
    }
  })
})

describe('command / forward：同一收口', () => {
  function commandHarness(): Harness {
    return harness(worldWithEntry(ARITH_ENTRY, ARITH), [commandFor(ARITH_ENTRY)])
  }

  function commandMessage(overrides: CommandOverrides): CommandMessage {
    return { v: '1', id: 'm2', kind: 'command', name: 'run', ...overrides } as CommandMessage
  }

  function forwardMessage(overrides: ForwardOverrides): ForwardMessage {
    return {
      v: '1',
      id: 'm3',
      kind: 'forward',
      identity: 'plugin.a',
      command: 'run',
      ...overrides,
    } as ForwardMessage
  }

  it('command：合法 limits 生效、畸形 limits 拒且不进 run', async () => {
    const legal = commandHarness()
    await legal.handlers.command(SOCKET, commandMessage({ limits: { gas: 1 } }), 'r2', null, SIGNAL)
    expect(resultFrames(legal.frames)[0]?.status).toBe('refused')

    const bad = commandHarness()
    await bad.handlers.command(SOCKET, commandMessage({ limits: { gas: 0 } }), 'r2', null, SIGNAL)
    expect(errorFrames(bad.frames)[0]?.code).toBe('bad_directive')
    expect(resultFrames(bad.frames)).toHaveLength(0)
    expect(bad.events).toEqual([])
  })

  it('forward：合法 caps 放行、畸形 caps 拒且不进 run', async () => {
    const legal = commandHarness()
    await legal.handlers.forward(SOCKET, forwardMessage({ caps: { a: true } }), 'r3', null, SIGNAL)
    expect(errorFrames(legal.frames)).toHaveLength(0)
    expect(resultFrames(legal.frames)[0]?.status).toBe('done')

    const bad = commandHarness()
    await bad.handlers.forward(SOCKET, forwardMessage({ caps: { a: 'yes' } }), 'r3', null, SIGNAL)
    expect(errorFrames(bad.frames)[0]?.code).toBe('bad_directive')
    expect(resultFrames(bad.frames)).toHaveLength(0)
    expect(bad.events).toEqual([])
  })
})
