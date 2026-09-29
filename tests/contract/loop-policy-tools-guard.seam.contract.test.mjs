// 接缝契约 6：loop-policy ↔ tools/guard。
// 共享真源：chain-contract/fixtures/node-io.json 的 `tool.gate.input` / `tool.dispatch.input` 形状。
// 消费方向：真实 guard 服务与真实 tools 服务分别消费 loop-policy 装配的 gateBag / dispatchBag。
// 供给方向：真实 loop-policy 解释器消费裁决与工具结果（含 `$directives` 冒泡、deny 回灌）。
// 至少一侧为真实服务：消费方向两侧都是真实服务（guard / tools 经 plugin-sdk 协议起进程）；
// 工具提供者（tool-fs / sandbox）为 Rust 构建件，此处按外部边界桩（fixtures 形状）应答，属文档化的对端替身。
import test from 'node:test'
import assert from 'node:assert/strict'

import { nodeIo } from '../../chain-contract/fixtures/index.ts'
import {
  startService as startLoop,
  defaultProviders,
  portError,
} from '../../plugins/loop-policy/test/driver.mjs'
import {
  startRealService,
  stopRealService,
  makeRouter,
  forward as routeForward,
} from './_bridge.mjs'

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** loop-policy 测试驱动的反向调用应答：真实服务的 `result` 帧取 `value`，`error` 帧转 `portError`。 */
function forward(service) {
  return (args, message) =>
    service
      .call(message.port, message.method, args, message.env)
      .then((frame) =>
        frame.kind === 'error' ? portError(frame.error, frame.message) : frame.value,
      )
}

const TOOLS = [
  {
    name: 'fs.read',
    provider: 'tool-fs',
    kind: 'invoke',
    method: null,
    read: null,
    description: '读文件',
    argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: true,
  },
]

/** 真实 guard 服务：无反向依赖。 */
function startGuard() {
  return startRealService({ name: 'guard' })
}

/**
 * 真实工具链：门面 `tools` + 下游 `tool-registry` / `tool-dispatch` / `tool-schema` 均为真实服务，
 * 逐跳异步桥接反向 `port.call`（模拟宿主按 pins 路由），只假最外部工具提供者（Rust 构建件）。
 * `providerRoutes` 形如 `{ '<port>.<method>': (args, message) => value | {ok,...} }`。
 */
function startToolsChain(providerRoutes = {}) {
  const schema = startRealService({ name: 'tool-schema' })
  const registry = startRealService({ name: 'tool-registry' })
  const dispatch = startRealService({
    name: 'tool-dispatch',
    onPortCall: makeRouter({
      'tool-schema.validate-args': routeForward(schema),
      'tool-schema.normalize-decl': routeForward(schema),
      'tool-schema.normalize-caps': routeForward(schema),
      'tool-registry.list': routeForward(registry),
      ...providerRoutes,
    }),
  })
  const tools = startRealService({
    name: 'tools',
    onPortCall: makeRouter({
      'tool-dispatch.dispatch': routeForward(dispatch),
      'tool-registry.list': routeForward(registry),
    }),
  })
  return {
    tools,
    async stop() {
      await stopRealService(tools)
      await stopRealService(dispatch)
      await stopRealService(registry)
      await stopRealService(schema)
    },
  }
}

/** 模型先调 fs.read，工具结果回灌后收尾。 */
function modelProviders() {
  return defaultProviders({
    'context.build': (args) => ({
      messages: [
        ...clone(nodeIo['context.assemble'].output.messages),
        ...(Array.isArray(args.extra_messages) ? clone(args.extra_messages) : []),
      ],
      params: { model: 'stub-model' },
      manifest: { dropped: 0 },
    }),
    'model.chat': (args) => {
      const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
      if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 'call-0', name: 'fs.read', args: { path: 'foo.ts' } }],
        usage: {},
      }
    },
  })
}

test('消费向：真实 guard 服务消费 gateBag（与夹具逐键一致）', async () => {
  const guard = startGuard()
  const chain = startToolsChain({
    'tool-fs.invoke': (args) => ({
      ok: true,
      result: {
        path: args.args?.path ?? null,
        lines: '1-240',
        sha: 'a1b2',
        content: '42: return obj.value',
      },
    }),
  })
  const gateBags = []
  const dispatchBags = []
  const loop = startLoop({
    providers: {
      ...modelProviders(),
      'guard.judge': (args, message) => {
        gateBags.push(clone(args))
        return forward(guard)(args, message)
      },
      'tools.dispatch': (args, message) => {
        dispatchBags.push(clone(args))
        return forward(chain.tools)(args, message)
      },
    },
  })
  try {
    await guard.hello()
    await chain.tools.hello()
    const result = await loop.interpret({
      tier: 'auto',
      tools: clone(TOOLS),
      sandbox_tiers: { tiers: { auto: { net: 'all' } } },
      workspace_root: '/repo',
      guard_rules: clone(nodeIo['tool.gate'].input.guard_rules),
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))

    // 真实 guard 服务消费的 gateBag 与共享夹具逐键一致（单一夹具源）。
    assert.equal(gateBags.length, 1)
    assert.deepEqual(gateBags[0], nodeIo['tool.gate'].input)

    // 真实 tools 服务消费的 dispatchBag：calls 形状 + 裁决经边传入。
    assert.equal(dispatchBags.length, 1)
    assert.deepEqual(dispatchBags[0].calls, [
      { call_id: 'call-0', tool: 'fs.read', args: { path: 'foo.ts' }, port: 'tool-fs' },
    ])
    assert.equal(dispatchBags[0].verdicts, 'allow')
    assert.equal(dispatchBags[0].tier, 'auto')
    assert.equal(dispatchBags[0].workspace_root, '/repo')

    // 真实 services 确被触达（两处反向帧证据）。
    assert.ok(loop.portCalls.some((call) => call.port === 'guard' && call.method === 'judge'))
    assert.ok(loop.portCalls.some((call) => call.port === 'tools' && call.method === 'dispatch'))
  } finally {
    loop.close()
    await loop.exit
    await chain.stop()
    await stopRealService(guard)
  }
})

test('供给向：真实 loop-policy 消费 deny 回灌（工具不派发、拒绝作工具结果）', async () => {
  const guard = startGuard()
  // 用一个会触发的哨兵：deny 时真实工具链不应被触达。
  let toolsTouched = 0
  const chain = startToolsChain({
    'tool-fs.invoke': () => {
      toolsTouched += 1
      return { ok: true, result: { path: 'foo.ts' } }
    },
  })
  const modelCalls = []
  const loop = startLoop({
    providers: {
      ...modelProviders(),
      'model.chat': (args) => {
        modelCalls.push(clone(args))
        const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
        if (last && last.role === 'tool')
          return { ok: true, text: 'picked another way', tool_calls: [], usage: {} }
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 'call-0', name: 'fs.read', args: { path: 'foo.ts' } }],
          usage: {},
        }
      },
      'guard.judge': forward(guard),
      'tools.dispatch': forward(chain.tools),
    },
  })
  try {
    await guard.hello()
    await chain.tools.hello()
    const result = await loop.interpret({
      tier: 'auto',
      tools: clone(TOOLS),
      sandbox_tiers: { tiers: { auto: { net: 'all' } } },
      workspace_root: '/repo',
      guard_rules: { deny: { calls: [{ port: 'tool-fs', tool: 'fs.read' }] } },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))

    // deny 属工具级拒绝：调用不得到达工具提供者（零副作用）。
    assert.equal(toolsTouched, 0, 'deny 后工具提供者不得被触达')
    assert.equal(
      loop.portCalls.some((call) => call.port === 'tools' && call.method === 'dispatch'),
      false,
    )
    assert.equal(modelCalls.length, 2, 'deny 后模型应被再次调用（换方案）')
    // 拒绝原因作为 tool 结果回灌给模型。
    const fedBack = modelCalls[1].messages.filter((message) => message.role === 'tool').pop()
    assert.ok(fedBack !== undefined, '模型须看到被拒工具的结果')
    assert.match(String(fedBack.content), /denied/)

    // 拒绝作工具结果回灌、回合继续（§十二 定案 3）：不是 refused 收口。
    const summary = result.value.$directives.find(
      (directive) => directive.kind === 'extern' && directive.payload?.kind === 'interpret',
    )
    assert.equal(summary.payload.ended, 'done')
  } finally {
    loop.close()
    await loop.exit
    await chain.stop()
    await stopRealService(guard)
  }
})

test('供给向：工具结果里的 $directives 冒泡进回合计划', async () => {
  const guard = startGuard()
  const put = {
    kind: 'write',
    request: { op: 'batch', args: { ops: [{ op: 'put', args: { body: { note: 'bubbled' } } }] } },
  }
  const chain = startToolsChain({
    'tool-fs.invoke': () => ({ ok: true, result: { path: 'foo.ts', $directives: [put] } }),
  })
  const loop = startLoop({
    providers: {
      ...modelProviders(),
      'guard.judge': forward(guard),
      'tools.dispatch': forward(chain.tools),
    },
  })
  try {
    await guard.hello()
    await chain.tools.hello()
    const result = await loop.interpret({
      tier: 'auto',
      tools: clone(TOOLS),
      sandbox_tiers: { tiers: { auto: { net: 'all' } } },
      workspace_root: '/repo',
      guard_rules: clone(nodeIo['tool.gate'].input.guard_rules),
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const bubbled = result.value.$directives.find(
      (directive) =>
        directive.kind === 'write' &&
        directive.request?.args?.ops?.[0]?.args?.body?.note === 'bubbled',
    )
    assert.ok(
      bubbled !== undefined,
      `工具结果的写计划须冒泡：${JSON.stringify(result.value.$directives)}`,
    )
  } finally {
    loop.close()
    await loop.exit
    await chain.stop()
    await stopRealService(guard)
  }
})
