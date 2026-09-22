// 解释器协议级测试：空 body 回落种子图、无工具路径与静态管道等价、有工具路径三分支、跨 run 续跑、
// 机械 post、verify 分档、拒绝短路、max_turn_iter、scope 过滤、提问往返。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, directivesOf, writeOps, portError } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'
import { patchQuestionAnswer } from '../execute/cursor.ts'

/** 递归找 `resume.command==='chat.resume'` 的续跑游标（#48 队列项写计划里的那份）。 */
function findResumeCursor(value) {
  let found = null
  const visit = (node) => {
    if (found !== null || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node.resume && node.resume.command === 'chat.resume' && node.resume.args && node.resume.args.cursor) {
      found = node.resume.args.cursor
      return
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(value)
  return found
}

function portSequence(service) {
  return service.portCalls.map((call) => `${call.port}.${call.method}`)
}

/** 取回合尾摘要 extern（payload.kind === 'interpret'）。 */
function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

/** 由种子六类条目 + 覆盖构造图包装。 */
function graphOf(overrides = {}) {
  const seed = seedModel()
  return {
    contracts: seed.contracts,
    nodes: [...seed.nodes, ...(overrides.nodes ?? [])],
    prompts: seed.prompts,
    graph: overrides.graph ?? seed.graph,
    thresholds: seed.thresholds,
    refusal_codes: seed.refusalCodes,
  }
}

test('空 body 回落种子图：无工具路径 = context.build → model.chat → session.commit', async () => {
  const service = startService()
  try {
    const manifest = await service.hello()
    assert.equal(manifest.identity, 'loop-policy')
    assert.deepEqual(manifest.methods['loop-policy'], ['interpret'])

    const result = await service.interpret({})
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const value = result.value
    assert.ok(Array.isArray(value.$directives), 'must return $directives')
    // context.assemble 先经 tools.list 取目录（空目录回落），再 context.build。
    assert.deepEqual(portSequence(service), ['tools.list', 'context.build', 'model.chat', 'session.commit'])
    const ops = writeOps(value)
    assert.ok(ops.some((op) => op.op === 'put' && op.args.body.role === 'assistant'), 'commit 写 assistant 消息')
    const summary = summaryOf(value)
    assert.equal(summary.fell_back, true, '空 body 应回落种子图')
    assert.equal(summary.ended, 'done')
  } finally {
    service.close()
  }
})

test('有工具路径 allow：assemble → step → gate → dispatch → verify → 重入 → commit', async () => {
  const calls = [{ call_id: 'c1', tool: 'edit', args: { path: 'a.txt', content: 'x' } }]
  const service = startService({
    providers: {
      'model.chat': (args) => {
        const last = args.messages?.[args.messages.length - 1]
        if (last && last.role === 'tool') return { ok: true, text: 'fixed', tool_calls: [], usage: { tokens: 3 } }
        return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt', content: 'x' } }], usage: { tokens: 4 } }
      },
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    const result = await service.interpret({
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service)
    assert.deepEqual(seq, [
      'context.build',
      'model.chat',
      'guard.judge',
      'tools.dispatch',
      'context.build',
      'model.chat',
      'session.commit',
    ])
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.iters, 2, '派发过工具应重入一次')
    assert.ok(summary.branch_not_taken >= 0)
  } finally {
    service.close()
  }
})

test('有工具路径 escalate：approval.wait 入队 ⇒ 本 run 正常返回（带游标）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }], summary: { allow: 0, escalate: 1, deny: 0 } }),
    },
  })
  try {
    const result = await service.interpret({})
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.deepEqual(portSequence(service), ['tools.list', 'context.build', 'model.chat', 'guard.judge', 'approval.enqueue'])
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'pending')
    assert.equal(summary.pending, 'approval')
    const enqueue = service.portCalls.find((call) => call.method === 'enqueue')
    assert.equal(enqueue.args.kind, 'tool_call')
    assert.equal(enqueue.args.port, 'tool', 'item.port 应为实际工具提供者能力类名')
    assert.equal(enqueue.args.cursor.kind, 'approval', '游标应随队列项落世界')
    assert.ok(Array.isArray(enqueue.args.cursor.executed))
    assert.equal(enqueue.args.cursor.original_input, null)
    // approval.pending 事件只由 #32 发；#33 不再重复发。
    assert.equal(service.events.some((event) => event.topic === 'approval.pending'), false)
  } finally {
    service.close()
  }
})

test('approvalBag：kind / port 由 gate verdict 的 (port, 工具名) 判据带出', async () => {
  for (const [tool, provider, kind] of [
    ['plugin.write', 'plugin-admin', 'plugin_write'],
    ['orchestration.propose', 'orchestration-admin', 'orchestration_change'],
  ]) {
    const service = startService({
      providers: {
        'tools.list': () => ({
          tools: [
            {
              name: tool,
              provider,
              kind: 'invoke',
              method: null,
              read: null,
              description: tool,
              argsSchema: { type: 'object' },
              caps: { fs: { read: 'none', write: 'none' } },
              idempotent: false,
            },
          ],
          rejected: [],
        }),
        'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: tool, args: {} }], usage: {} }),
        'guard.judge': (args) => ({
          decisions: args.calls.map((call, index) => ({ index, port: call.port, tool: call.tool, verdict: 'escalate' })),
          summary: { allow: 0, escalate: 1, deny: 0 },
        }),
      },
    })
    try {
      await service.interpret({})
      const enqueue = service.portCalls.find((call) => call.method === 'enqueue')
      assert.equal(enqueue.args.kind, kind, `${tool} 应判为 ${kind}`)
      assert.equal(enqueue.args.port, provider, `${tool} 的 port 应为 ${provider}`)
    } finally {
      service.close()
    }
  }
})

test('审批裁决后经 resume 续跑：approved → dispatch → 重入', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'approved done', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
    },
    'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }], summary: { allow: 0, escalate: 1, deny: 0 } }),
    'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
  }
  const first = startService({ providers })
  let cursor
  try {
    const result = await first.interpret({})
    const enqueue = first.portCalls.find((call) => call.method === 'enqueue')
    cursor = enqueue.args.cursor
    assert.equal(cursor.kind, 'approval')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    const result = await second.interpret({ resume: { cursor, thread: 't1', payload: { verdict: 'approved' } } })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(second)
    assert.ok(seq.includes('tools.dispatch'), `应继续 dispatch：${seq.join(',')}`)
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
  } finally {
    second.close()
  }
})

test('审批裁决词汇：槽词汇 accept/deny 映射为 approved/denied 后继续派发', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'accepted done', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
    },
    'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }], summary: { allow: 0, escalate: 1, deny: 0 } }),
    'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
  }
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({})
    cursor = first.portCalls.find((call) => call.method === 'enqueue').args.cursor
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    // #39 ui-approval 续跑 payload 用槽词汇 accept（非 approved）——#33 须映射后才能命中 approved 边。
    const result = await second.interpret({ resume: { cursor, thread: 't1', payload: { verdict: 'accept' } } })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', `accept 应继续派发而非拒绝：${JSON.stringify(summary)}`)
    assert.ok(portSequence(second).includes('tools.dispatch'), `accept 后应继续 dispatch：${portSequence(second).join(',')}`)
  } finally {
    second.close()
  }
})

test('批准续跑构造一次性 caps.grant：approved 带 grant、denied 不带', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
    },
    'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }], summary: { allow: 0, escalate: 1, deny: 0 } }),
    'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
  }
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({})
    cursor = first.portCalls.find((call) => call.method === 'enqueue').args.cursor
  } finally {
    first.close()
  }

  const approved = startService({ providers })
  try {
    await approved.interpret({ resume: { cursor, thread: 't1', payload: { verdict: 'approved' } } })
    const dispatchCall = approved.portCalls.find((call) => call.port === 'tools' && call.method === 'dispatch')
    assert.ok(dispatchCall, '批准后应派发工具')
    const grant = dispatchCall.args.grant
    assert.ok(grant, '批准路径的 tool.dispatch bag 应带一次性 caps.grant')
    assert.equal(grant.call_id, 'c1', 'grant 绑定被批准的 call_id')
    assert.equal(grant.op, 'write', 'edit（old 空）映射 fsop op=write')
    assert.deepEqual(grant.paths, ['a.txt'])
    assert.equal(grant.tier, null)
    assert.ok(grant.expires > 1_700_000_000_000, 'grant 带 expires（帧 env.now + TTL）')
  } finally {
    approved.close()
  }

  const denied = startService({ providers })
  try {
    await denied.interpret({ resume: { cursor, thread: 't1', payload: { verdict: 'denied' } } })
    assert.ok(!portSequence(denied).includes('tools.dispatch'), '拒绝路径不应派发工具')
    assert.ok(denied.portCalls.every((call) => call.args?.grant === undefined), '拒绝路径不应带 grant')
  } finally {
    denied.close()
  }
})

test('approval 队列随 bag 传入：enqueue 收到当前队列 body 与 refs（不重置队列）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }], summary: { allow: 0, escalate: 1, deny: 0 } }),
    },
  })
  try {
    const queue = { version: 1, tail: { def: 'f'.repeat(64) }, count: 1 }
    const refs = { ['f'.repeat(64)]: { id: 'ap-old', status: 'pending' } }
    await service.interpret({ approval: { queue, refs } })
    const enqueue = service.portCalls.find((call) => call.method === 'enqueue')
    assert.deepEqual(enqueue.args.queue, queue, 'enqueue 应收到当前队列 body')
    assert.deepEqual(enqueue.args.refs, refs, 'enqueue 应收到引用闭包')
  } finally {
    service.close()
  }
})

test('工具结果里的写计划冒泡：#33 收集 results[].result.$directives 并入回合尾计划', async () => {
  const nested = { kind: 'extern', payload: { ok: true, marker: 'nested-plan' } }
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } }], usage: {} }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { $directives: [nested] } })),
      }),
    },
  })
  try {
    const result = await service.interpret({})
    const directives = directivesOf(result.value)
    assert.ok(
      directives.some((item) => item.kind === 'extern' && item.payload?.marker === 'nested-plan'),
      `工具结果计划应冒泡到顶层：${JSON.stringify(directives)}`,
    )
  } finally {
    service.close()
  }
})

test('机械 post：畸形 tool_call 在 agent.step 被拦，不进 #27', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: '', args: {} }], usage: {} }),
    },
  })
  try {
    const result = await service.interpret({})
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service)
    assert.ok(!seq.includes('tools.dispatch'), `不应进 #27：${seq.join(',')}`)
    assert.ok(seq.includes('session.commit'), '拒绝后短路到 sink')
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'capability_mismatch')
    assert.equal(summary.refused_at.node_index, 1)
  } finally {
    service.close()
  }
})

test('verify 默认零成本：未配命令只选 noop、不发 eff', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    await service.interpret({ tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }] })
    const dispatchCalls = service.portCalls.filter((call) => call.method === 'dispatch')
    // 第一次 dispatch 是 tool.dispatch（编辑），verify 是 noop ⇒ 不出现 shell 调用。
    assert.ok(!dispatchCalls.some((call) => call.args.calls?.some((c) => c.tool === 'shell')), 'verify noop 不应跑 shell')
  } finally {
    service.close()
  }
})

test('verify 配置命令：workspace 实例被选中并跑真命令', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: call.tool === 'shell' ? { passed: true, detail: 'ok', exit_code: 0 } : { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    const graph = graphOf({
      nodes: [
        { node_id: 'vf-w1', contract_id: 'verify', impl: 'atomic', bindings: { command: 'npm test' }, autonomy: 'L0', scope: { kind: 'workspace', workspace_id: 'w1' } },
      ],
    })
    await service.interpret({ workspace_id: 'w1', graph })
    const shellCall = service.portCalls.find((call) => call.method === 'dispatch' && call.args.calls?.some((c) => c.tool === 'shell'))
    assert.ok(shellCall, '配了命令应跑 shell')
    assert.equal(shellCall.args.calls[0].args.command, 'npm test')
  } finally {
    service.close()
  }
})

test('verify 失败不阻断收口：仍 commit、报告进上下文并重入', async () => {
  const service = startService({
    providers: {
      'model.chat': (args) => {
        const last = args.messages?.[args.messages.length - 1]
        if (last && last.role === 'tool' && String(last.content).startsWith('verify:')) {
          return { ok: true, text: 'handled verify failure', tool_calls: [], usage: {} }
        }
        return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
      },
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: call.tool === 'shell' ? { passed: false, detail: 'tests failed', exit_code: 1 } : { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    const graph = graphOf({
      nodes: [
        { node_id: 'vf-w1', contract_id: 'verify', impl: 'atomic', bindings: { command: 'npm test' }, autonomy: 'L0', scope: { kind: 'workspace', workspace_id: 'w1' } },
      ],
    })
    const result = await service.interpret({ workspace_id: 'w1', tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }], graph })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.ok(summary.iters >= 2, 'verify 失败应触发下一 iter')
    assert.ok(portSequence(service).includes('session.commit'), '校验失败仍收口 commit')
    const modelMsgs = service.portCalls.filter((c) => c.port === 'model').map((c) => c.args.messages)
    assert.ok(modelMsgs.some((msgs) => msgs.some((m) => m.role === 'tool' && String(m.content).startsWith('verify:'))), '报告应进下一 iter 上下文')
  } finally {
    service.close()
  }
})

test('max_turn_iter 达上限仍派发 ⇒ 落 budget 码', async () => {
  let step = 0
  const service = startService({
    providers: {
      'model.chat': () => {
        step += 1
        return { ok: true, text: '', tool_calls: [{ id: `c${step}`, name: 'edit', args: { path: 'a.txt' } }], usage: {} }
      },
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    const result = await service.interpret({ tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }] })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'budget')
  } finally {
    service.close()
  }
})

test('scope 过滤：B 工作区不选 A 的 workspace 实例', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: 'answered', tool_calls: [], usage: {} }),
    },
  })
  try {
    const seed = seedModel()
    const contracts = seed.contracts.filter((c) => c.contract_id === 'context.assemble' || c.contract_id === 'agent.step')
    const nodes = [
      { node_id: 'as-assemble', contract_id: 'context.assemble', impl: 'atomic', entry: { cap: 'context', method: 'build' }, scope: { kind: 'global' } },
      { node_id: 'step-a', contract_id: 'agent.step', impl: 'atomic', entry: { cap: 'model', method: 'chat' }, bindings: { agent: 'agent-a' }, scope: { kind: 'workspace', workspace_id: 'A' } },
      { node_id: 'step-b', contract_id: 'agent.step', impl: 'atomic', entry: { cap: 'model', method: 'chat' }, bindings: { agent: 'agent-b' }, scope: { kind: 'global' } },
    ]
    const graph = {
      contracts,
      nodes,
      prompts: seed.prompts,
      graph: {
        nodes: ['context.assemble', 'agent.step'],
        edges: [{ from: [0, 'messages'], to: [1, 'messages'] }],
        entry_supply: [{ type_id: 'task' }],
        loop: { when: '', max_iter: 'max_turn_iter' },
        sink: 1,
      },
      thresholds: seed.thresholds,
      refusal_codes: seed.refusalCodes,
    }
    const result = await service.interpret({ workspace_id: 'B', graph })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    const chosen = new Map(summary.instances)
    assert.equal(chosen.get(1), 'step-b', 'B 工作区下 workspace:A 实例不进候选集')
  } finally {
    service.close()
  }
})

test('拒绝短路：deny ⇒ 直接 sink 带码收口', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'shell', args: { command: 'rm -rf /' } }], usage: {} }),
      'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'shell', verdict: 'deny' }], summary: { allow: 0, escalate: 0, deny: 1 } }),
    },
  })
  try {
    const result = await service.interpret({})
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'denied')
    assert.ok(!portSequence(service).includes('tools.dispatch'), 'deny 不应派发工具')
  } finally {
    service.close()
  }
})

test('提问往返：question 工具 ⇒ question_pending 为真 ⇒ 不 loop、正常结束', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } }], usage: {} }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { status: 'pending' } })) }),
    },
  })
  try {
    const result = await service.interpret({})
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.iters, 1, '不应重入')
    const dispatchCall = service.portCalls.find((call) => call.method === 'dispatch')
    assert.equal(dispatchCall.args.cursor.kind, 'question', 'question 游标应传给 #48')
  } finally {
    service.close()
  }
})

test('todo_incomplete 为真 ⇒ 继续 loop', async () => {
  let step = 0
  const service = startService({
    providers: {
      'model.chat': () => {
        step += 1
        if (step >= 2) return { ok: true, text: 'all done', tool_calls: [], usage: {} }
        return { ok: true, text: 'working', tool_calls: [], usage: {} }
      },
    },
  })
  try {
    const result = await service.interpret({ todo: { items: [{ id: 't1', status: 'pending' }] } })
    const summary = summaryOf(result.value)
    assert.ok(summary.iters >= 2, `todo 未完成应重入：iters=${summary.iters}`)
  } finally {
    service.close()
  }
})

test('提问续跑：答案经 resume 回灌 tool.dispatch，重入后收口', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } }], usage: {} }
    },
    'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { status: 'pending' } })) }),
  }
  const first = startService({ providers })
  let cursor
  try {
    await first.interpret({})
    const dispatchCall = first.portCalls.find((call) => call.method === 'dispatch')
    cursor = dispatchCall.args.cursor
    assert.equal(cursor.kind, 'question')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    const result = await second.interpret({ resume: { cursor, thread: 't1', payload: { answers: [{ id: 'x', answer: 'yes' }] } } })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.iters, 2, '答案回灌后应重入一次')
    const secondStep = second.portCalls.filter((call) => call.port === 'model')
    assert.ok(secondStep.length >= 1)
  } finally {
    second.close()
  }
})

test('transport_failed：节点传输失败 ⇒ 拒绝码 transport_failed', async () => {
  const service = startService({
    providers: {
      'model.chat': () => portError('boom', 'no model'),
    },
  })
  try {
    const result = await service.interpret({})
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.refused_at.code, 'transport_failed')
    assert.equal(summary.refused_at.attributable_to, 'node')
  } finally {
    service.close()
  }
})

test('bag.tools：context.assemble 经 tools.list 取非空目录 → 模型可见 + tool.dispatch 复用', async () => {
  const directory = {
    tools: [
      {
        name: 'edit',
        provider: 'tool-fs',
        kind: 'invoke',
        method: null,
        read: null,
        description: '编辑文件',
        argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        caps: { fs: { read: 'workspace', write: 'workspace' } },
        idempotent: false,
      },
    ],
    rejected: [],
  }
  let step = 0
  const service = startService({
    providers: {
      'tools.list': () => directory,
      'model.chat': () => {
        step += 1
        if (step > 1) return { ok: true, text: 'done after tools', tool_calls: [], usage: {} }
        return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
      },
      'tool-fs.invoke': (args) => ({ ok: true, result: { path: args.args.path } }),
    },
  })
  try {
    const result = await service.interpret({ tools_bindings: { bindings: {} }, mcp_tools: [] })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service)
    assert.equal(seq[0], 'tools.list', 'context.assemble 前应取目录')
    assert.equal(seq.filter((key) => key === 'tools.list').length, 1, '目录只取一次（重入复用）')
    const contextCall = service.portCalls.find((call) => call.port === 'context' && call.method === 'build')
    assert.equal(contextCall.args.tools.length, 1, 'context.build 应收到非空目录')
    const firstModel = service.portCalls.find((call) => call.port === 'model')
    assert.equal(firstModel.args.tools.length, 1, '模型应看到非空工具目录')
    assert.equal(firstModel.args.tools[0].name, 'edit')
    const dispatchCall = service.portCalls.find((call) => call.port === 'tools' && call.method === 'dispatch')
    assert.ok(dispatchCall, '应派发工具')
    assert.equal(dispatchCall.args.directory.tools.length, 1, 'tool.dispatch 复用同一目录')
    assert.equal(dispatchCall.args.tools.length, 1)
    assert.equal(dispatchCall.args.calls[0].port, 'tool-fs', '(port, tool) 判据用目录解析出的提供者')
  } finally {
    service.close()
  }
})

test('patchQuestionAnswer：派发后游标只替换 question 项，保留同批其它真实结果', () => {
  const iter = {
    outputs: new Map([
      [4, { results: [{ call_id: 'e1', ok: true, result: { marker: 'edit-real' } }, { call_id: 'q1', ok: true, result: { status: 'pending' } }] }],
    ]),
    inputs: new Map(),
    executed: new Set(),
  }
  patchQuestionAnswer(iter, 4, 'q1', { answers: [{ id: 'x', answer: 'yes' }] }, [])
  const results = iter.outputs.get(4).results
  assert.deepEqual(results[0].result, { marker: 'edit-real' }, '非 question 项真实结果应保留')
  assert.deepEqual(results[1].result, { answers: [{ id: 'x', answer: 'yes' }] })
  assert.ok(iter.executed.has(4))
})

test('提问续跑：队列项游标含派发后整批结果（不重建同批其它工具）', async () => {
  const queueDirective = (cursor) => ({
    kind: 'write',
    request: {
      op: 'batch',
      args: { ops: [{ op: 'put', args: { body: { id: 'q-item', resume: { command: 'chat.resume', args: { cursor, thread: 't1' } } } } }] },
    },
  })
  const providers = {
    'tools.list': () => ({ tools: [], rejected: [] }),
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [
          { id: 'e1', name: 'edit', args: { path: 'a.txt' } },
          { id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } },
        ],
        usage: {},
      }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) =>
        call.tool === 'question'
          ? { call_id: call.call_id, ok: true, result: { status: 'pending', $directives: [queueDirective(args.cursor)] } }
          : { call_id: call.call_id, ok: true, result: { path: 'a.txt', marker: 'edit-real' } },
      ),
    }),
  }
  const first = startService({ providers })
  let cursor
  try {
    const result = await first.interpret({})
    cursor = findResumeCursor(result.value)
    assert.ok(cursor, '队列项应带续跑游标')
    const dispatchOutput = cursor.outputs[String(4)]
    assert.ok(dispatchOutput, '游标应含派发后 tool.dispatch 产出')
    const editItem = dispatchOutput.results.find((item) => item.call_id === 'e1')
    assert.equal(editItem.result.marker, 'edit-real', '同批其它工具真实结果应进游标')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    const result = await second.interpret({ resume: { cursor, thread: 't1', payload: { answers: [{ id: 'x', answer: 'yes' }] } } })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.iters, 2, '答案回灌后应重入一次')
  } finally {
    second.close()
  }
})

test('resume 保留原始 bag.input：作答时刻槽已是 question.answer 也不丢原用户消息', async () => {
  const queueDirective = (cursor) => ({
    kind: 'write',
    request: {
      op: 'batch',
      args: { ops: [{ op: 'put', args: { body: { id: 'q-item', resume: { command: 'chat.resume', args: { cursor, thread: 't1' } } } } }] },
    },
  })
  const providers = {
    'tools.list': () => ({ tools: [], rejected: [] }),
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return { ok: true, text: '', tool_calls: [{ id: 'q1', name: 'question', args: {} }], usage: {} }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { status: 'pending', $directives: [queueDirective(args.cursor)] } })),
    }),
  }
  const first = startService({ providers })
  let cursor
  try {
    const result = await first.interpret({ input: { content: '原始用户消息' } })
    cursor = findResumeCursor(result.value)
    assert.equal(cursor.original_input.content, '原始用户消息', '游标应纳入原始输入')
  } finally {
    first.close()
  }
  const second = startService({ providers })
  try {
    await second.interpret({ input: { content: '' }, resume: { cursor, thread: 't1', payload: { answers: [{ id: 'x', answer: 'yes' }] } } })
    const contextCall = second.portCalls.find((call) => call.port === 'context' && call.method === 'build')
    assert.equal(contextCall.args.input.content, '原始用户消息', '恢复应优先用游标内原始输入')
  } finally {
    second.close()
  }
})

test('dispatchBag 透传 grant：#27 收到一次性 caps.grant', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({ ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }),
      'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    },
  })
  try {
    await service.interpret({
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
      grant: { call_id: 'c1', tier: 'severe' },
    })
    const dispatchCall = service.portCalls.find((call) => call.port === 'tools' && call.method === 'dispatch')
    assert.deepEqual(dispatchCall.args.grant, { call_id: 'c1', tier: 'severe' })
  } finally {
    service.close()
  }
})
