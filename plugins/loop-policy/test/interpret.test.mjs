// 解释器协议级测试：空 body 回落种子图、无工具路径与静态管道等价、有工具路径三分支、跨 run 续跑、
// 机械 post、verify 分档、拒绝短路、max_turn_iter、scope 过滤、提问往返。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, directivesOf, writeOps, writeBatches, portError } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'
import { patchQuestionAnswer } from '../execute/cursor.ts'
import { H } from '../execute/hash.ts'

/** 递归找 `resume.command==='chat.resume'` 的续跑游标（#48 队列项写计划里的那份）。 */
function findResumeCursor(value) {
  let found = null
  const visit = (node) => {
    if (found !== null || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (
      node.resume &&
      node.resume.command === 'chat.resume' &&
      node.resume.args &&
      node.resume.args.cursor
    ) {
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

/** 去掉回合日志写（`session.*`）与机械闸（`graph-gate.*`）后的核心端口序，便于逐节点断言。 */
function coreSequence(service) {
  return portSequence(service).filter(
    (key) => !key.startsWith('session.') && !key.startsWith('graph-gate.'),
  )
}

function stepsOf(service) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'step_append')
    .map((call) => call.args)
}

function stepResults(service) {
  return stepsOf(service).filter((record) => record.type === 'step.result')
}

function settlesOf(service) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'turn_settle')
    .map((call) => call.args)
}

/** 取回合尾摘要 extern（payload.kind === 'interpret'）。 */
function summaryOf(value) {
  for (const directive of directivesOf(value)) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret')
      return directive.payload
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

test('空 body 回落种子图：无工具路径 = context.build → model.chat → 回合尾步记录 + settle', async () => {
  const service = startService()
  try {
    const manifest = await service.hello()
    assert.equal(manifest.identity, 'loop-policy')
    assert.deepEqual(manifest.methods['loop-policy'], ['interpret', 'cancel'])

    const result = await service.interpret({ turn_id: 't1' })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const value = result.value
    assert.ok(Array.isArray(value.$directives), 'must return $directives')
    // context.assemble 先经 tools.list 取目录（空目录回落），再 context.build。
    assert.deepEqual(coreSequence(service), ['tools.list', 'context.build', 'model.chat'])
    // 回合尾内容经 step_append 落盘，收口经 turn_settle（不再有 session.commit）。
    assert.equal(portSequence(service).includes('session.commit'), false, '回合尾一次写已退役')
    const finals = stepResults(service)
    assert.equal(finals.length, 1, '纯文本回合落一条最终助手步记录')
    assert.equal(typeof finals[0].assistant.content, 'string')
    const settle = settlesOf(service)
    assert.equal(settle.length, 1)
    assert.equal(settle[0].outcome.kind, 'committed')
    const summary = summaryOf(value)
    assert.equal(summary.fell_back, true, '空 body 应回落种子图')
    assert.equal(summary.ended, 'done')
    assert.equal(summary.settled, true)
    assert.equal(summary.turn_id, 't1')
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
        if (last && last.role === 'tool')
          return { ok: true, text: 'fixed', tool_calls: [], usage: { tokens: 3 } }
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt', content: 'x' } }],
          usage: { tokens: 4 },
        }
      },
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }],
        summary: { allow: 1, escalate: 0, deny: 0 },
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.deepEqual(coreSequence(service), [
      'context.build',
      'model.chat',
      'guard.judge',
      'tools.dispatch',
      'context.build',
      'model.chat',
    ])
    // 先写意图再执行：intent 在 tools.dispatch 之前落盘，result 在其后。
    const seq = portSequence(service)
    const intentIndex = seq.indexOf('session.step_append')
    const dispatchIndex = seq.indexOf('tools.dispatch')
    assert.ok(
      intentIndex >= 0 && intentIndex < dispatchIndex,
      'step.intent 必须先于 tools.dispatch',
    )
    const intents = stepsOf(service).filter((record) => record.type === 'step.intent')
    assert.equal(intents.length, 1)
    assert.equal(intents[0].tool_calls[0].name, 'edit')
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.iters, 2, '派发过工具应重入一次')
    assert.equal(summary.outcome.kind, 'committed')
    assert.ok(summary.branch_not_taken >= 0)
  } finally {
    service.close()
  }
})

test('工具调用回灌：assistant(tool_calls) → tool(tool_call_id) 进入重入 iter 的 messages', async () => {
  const seen = []
  const service = startService({
    providers: {
      'model.chat': (args) => {
        seen.push(args.messages ?? [])
        const hasLinkage = (args.messages ?? []).some(
          (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
        )
        if (hasLinkage) return { ok: true, text: 'done', tool_calls: [], usage: {} }
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
          usage: {},
        }
      },
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }],
        summary: { allow: 1, escalate: 0, deny: 0 },
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    await service.interpret({
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    assert.equal(seen.length, 2, '应两次模型调用（调用工具 → 结果回灌后作答）')
    const second = seen[1]
    const assistant = second.find(
      (message) => message.role === 'assistant' && Array.isArray(message.tool_calls),
    )
    const tool = second.find((message) => message.role === 'tool')
    assert.ok(assistant, 'assistant 承接帧（带 tool_calls）须回灌，否则模型会反复重调')
    assert.equal(assistant.tool_calls[0].id, 'c1')
    assert.equal(assistant.tool_calls[0].name, 'edit')
    assert.deepEqual(assistant.tool_calls[0].arguments, { path: 'a.txt' })
    assert.equal(tool.tool_call_id, 'c1', '工具结果须带 tool_call_id 与调用配对')
  } finally {
    service.close()
  }
})

test('落盘展示 parts：推理 / 正文 / 工具卡按到达序写入 commit，带 render 与结果', async () => {
  const service = startService({
    providers: {
      'model.chat': (args) => {
        const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
        if (last && last.role === 'tool') {
          return { ok: true, text: '收尾', reasoning: '想收尾', tool_calls: [], usage: {} }
        }
        return {
          ok: true,
          text: '先查一下',
          reasoning: '该用 edit 改文件',
          tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt', old: 'x', new: 'y' } }],
          usage: {},
        }
      },
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }],
        summary: { allow: 1, escalate: 0, deny: 0 },
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { added: 1, removed: 1, patch: '@@ -1 +1 @@\n-x\n+y' },
        })),
      }),
    },
  })
  try {
    await service.interpret({
      turn_id: 't1',
      tools: [
        {
          name: 'edit',
          provider: 'tool',
          caps: { fs: { write: 'workspace' } },
          render: {
            form: 'card',
            label: 'edit',
            summary: '{path}',
            tone: 'plain',
            detail: { kind: 'diff' },
          },
        },
      ],
    })
    const finalStep = stepResults(service).at(-1)
    assert.ok(finalStep, '应有最终助手步记录')
    const parts = finalStep.assistant.parts
    assert.ok(Array.isArray(parts), '落盘 assistant 应带展示 parts')
    assert.deepEqual(
      parts.map((part) => part.type),
      ['reasoning', 'text', 'tool', 'reasoning', 'text'],
    )
    assert.equal(parts[0].text, '该用 edit 改文件')
    assert.equal(parts[1].text, '先查一下')
    assert.equal(parts[2].call_id, 'c1')
    assert.equal(parts[2].tool, 'edit')
    assert.equal(parts[2].status, 'ok')
    assert.deepEqual(parts[2].result, { added: 1, removed: 1, patch: '@@ -1 +1 @@\n-x\n+y' })
    assert.equal(parts[2].render.detail.kind, 'diff', '工具卡 render 从目录带入')
    assert.equal(parts[3].text, '想收尾')
    assert.equal(parts[4].text, '收尾')
  } finally {
    service.close()
  }
})

test('纯文本回合不写展示 parts（content 已覆盖，历史不膨胀）', async () => {
  const service = startService()
  try {
    await service.interpret({ turn_id: 't1' })
    const finalStep = stepResults(service).at(-1)
    assert.ok(finalStep, '应有最终助手步记录')
    assert.equal(finalStep.assistant.parts, undefined)
    assert.equal(typeof finalStep.assistant.content, 'string')
  } finally {
    service.close()
  }
})

test('建会话不归 loop-policy：new_conversation 不再经本插件落盘（归 chat.turn_open）', async () => {
  const service = startService()
  try {
    const spec = { id: 'c9', workspace_id: 'w1', title: '生成的标题' }
    await service.interpret({ turn_id: 't1', new_conversation: spec })
    assert.equal(portSequence(service).includes('session.commit'), false)
    assert.ok(
      service.portCalls
        .filter((call) => call.port === 'session')
        .every((call) => JSON.stringify(call.args).indexOf('new_conversation') < 0),
      'new_conversation 不应出现在任何 session 反向调用里',
    )
  } finally {
    service.close()
  }
})

test('有工具路径 escalate：approval.wait 入队 ⇒ 显式挂起收口（带游标，先落账本轮）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }),
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
        summary: { allow: 0, escalate: 1, deny: 0 },
      }),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1' })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    // 入队后显式挂起收口：已发生的助手消息以 step.result 落盘，回合不收口（awaiting 是段终态）。
    assert.deepEqual(coreSequence(service), [
      'tools.list',
      'context.build',
      'model.chat',
      'guard.judge',
      'approval.enqueue',
    ])
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'pending')
    assert.equal(summary.pending, 'approval')
    assert.equal(summary.outcome, undefined, '挂起不是回合终态，不写结局')
    assert.equal(settlesOf(service).length, 0, '段终态不 settle')
    const enqueue = service.portCalls.find((call) => call.method === 'enqueue')
    assert.equal(enqueue.args.kind, 'tool_call')
    assert.equal(enqueue.args.port, 'tool', 'item.port 应为实际工具提供者能力类名')
    assert.equal(enqueue.args.cursor.kind, 'approval', '游标应随队列项落世界')
    assert.equal(enqueue.args.cursor.turn_id, 't1', '游标携带回合身份供续跑续同一回合')
    assert.ok(Array.isArray(enqueue.args.cursor.executed))
    assert.equal(enqueue.args.cursor.original_input, null)
    const partial = stepResults(service).find((record) => record.assistant?.parts)
    assert.ok(partial, '挂起时助手承接帧（含工具卡）先落盘')
    const toolPart = partial.assistant.parts.find((part) => part.type === 'tool')
    assert.equal(toolPart.status, null, '审批未决，工具卡状态留空')
    // approval.pending 事件只由 #32 发；#33 不再重复发。
    assert.equal(
      service.events.some((event) => event.topic === 'approval.pending'),
      false,
    )
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
        'model.chat': () => ({
          ok: true,
          text: '',
          tool_calls: [{ id: 'c1', name: tool, args: {} }],
          usage: {},
        }),
        'guard.judge': (args) => ({
          decisions: args.calls.map((call, index) => ({
            index,
            port: call.port,
            tool: call.tool,
            verdict: 'escalate',
          })),
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
      if (last && last.role === 'tool')
        return { ok: true, text: 'approved done', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }
    },
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({
        call_id: call.call_id,
        ok: true,
        result: { path: 'a.txt' },
      })),
    }),
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
    const result = await second.interpret({
      resume: { cursor, thread: 't1', payload: { verdict: 'approved' } },
    })
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
      if (last && last.role === 'tool')
        return { ok: true, text: 'accepted done', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }
    },
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({
        call_id: call.call_id,
        ok: true,
        result: { path: 'a.txt' },
      })),
    }),
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
    const result = await second.interpret({
      resume: { cursor, thread: 't1', payload: { verdict: 'accept' } },
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', `accept 应继续派发而非拒绝：${JSON.stringify(summary)}`)
    assert.ok(
      portSequence(second).includes('tools.dispatch'),
      `accept 后应继续 dispatch：${portSequence(second).join(',')}`,
    )
  } finally {
    second.close()
  }
})

test('批准续跑构造一次性 caps.grant：approved 带 grant、denied 不带', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }
    },
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({
        call_id: call.call_id,
        ok: true,
        result: { path: 'a.txt' },
      })),
    }),
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
    const dispatchCall = approved.portCalls.find(
      (call) => call.port === 'tools' && call.method === 'dispatch',
    )
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
    assert.ok(
      denied.portCalls.every((call) => call.args?.grant === undefined),
      '拒绝路径不应带 grant',
    )
  } finally {
    denied.close()
  }
})

test('stat 工具映射 fsop op=stat：批准后为只读一次性 grant', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool') return { ok: true, text: 'done', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 's1', name: 'stat', args: { path: 'C:\\out\\x' } }],
        usage: {},
      }
    },
    'guard.judge': () => ({
      decisions: [{ index: 0, port: 'tool', tool: 'stat', verdict: 'escalate' }],
      summary: { allow: 0, escalate: 1, deny: 0 },
    }),
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: {} })),
    }),
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
    const dispatchCall = approved.portCalls.find(
      (call) => call.port === 'tools' && call.method === 'dispatch',
    )
    assert.ok(dispatchCall, '批准后应派发工具')
    const grant = dispatchCall.args.grant
    assert.equal(grant.op, 'stat', 'stat 映射 fsop op=stat')
    assert.deepEqual(grant.fs, { read: 'full' }, 'stat 为只读授权')
    assert.deepEqual(grant.paths, ['C:\\out\\x'])
  } finally {
    approved.close()
  }
})

test('approval 队列随 bag 传入：enqueue 收到当前队列 body 与 refs（不重置队列）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }),
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'escalate' }],
        summary: { allow: 0, escalate: 1, deny: 0 },
      }),
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
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [
          { id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } },
        ],
        usage: {},
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { $directives: [nested] },
        })),
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

test('展示 parts 剥离计划通道：工具结果取 extern 载荷、不含 $directives、$n 字面量转义', async () => {
  const plan = {
    $directives: [
      {
        kind: 'write',
        request: { op: 'batch', args: { ops: [{ op: 'put', args: { body: { $n: 1 } } }] } },
      },
      {
        kind: 'extern',
        payload: { ok: true, total: 1, items: [{ text: 'x', status: 'pending' }], note: { $n: 0 } },
      },
    ],
  }
  const service = startService({
    providers: {
      'model.chat': (args) => {
        const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
        if (last && last.role === 'tool')
          return { ok: true, text: '收尾', tool_calls: [], usage: {} }
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 't1', name: 'todo', args: { conversation_id: 'c1' } }],
          usage: {},
        }
      },
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'todo', tool: 'todo', verdict: 'allow' }],
        summary: { allow: 1, escalate: 0, deny: 0 },
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: plan })),
      }),
    },
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      tools: [{ name: 'todo', provider: 'todo', render: { form: 'card', label: 'todo' } }],
    })
    const finalStep = stepResults(service).at(-1)
    assert.ok(finalStep, '应有最终助手步记录')
    const part = finalStep.assistant.parts.find((item) => item.type === 'tool')
    assert.deepEqual(part.result, {
      ok: true,
      total: 1,
      items: [{ text: 'x', status: 'pending' }],
      note: { $lit: { $n: 0 } },
    })
    assert.equal(
      JSON.stringify(part.result).includes('$directives'),
      false,
      '展示结果不得带计划通道',
    )
    // 顶层计划照常冒泡（剥离只作用于展示数据）
    assert.ok(
      directivesOf(result.value).some((item) => item.kind === 'write'),
      '工具结果计划仍冒泡到顶层',
    )
  } finally {
    service.close()
  }
})

test('机械 post：畸形 tool_call 在 agent.step 被拦，不进 #27', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: '', args: {} }],
        usage: {},
      }),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1' })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service)
    assert.ok(!seq.includes('tools.dispatch'), `不应进 #27：${seq.join(',')}`)
    const settle = settlesOf(service)[0]
    assert.equal(settle.outcome.kind, 'refused', '拒绝后短路到 sink 并收口')
    assert.equal(settle.outcome.code, 'capability_mismatch')
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
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    await service.interpret({
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    const dispatchCalls = service.portCalls.filter((call) => call.method === 'dispatch')
    // 第一次 dispatch 是 tool.dispatch（编辑），verify 是 noop ⇒ 不出现 shell 调用。
    assert.ok(
      !dispatchCalls.some((call) => call.args.calls?.some((c) => c.tool === 'shell')),
      'verify noop 不应跑 shell',
    )
  } finally {
    service.close()
  }
})

test('verify 配置命令：workspace 实例被选中并跑真命令', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result:
            call.tool === 'shell'
              ? { passed: true, detail: 'ok', exit_code: 0 }
              : { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    const graph = graphOf({
      nodes: [
        {
          node_id: 'vf-w1',
          contract_id: 'verify',
          impl: 'atomic',
          bindings: { command: 'npm test' },
          autonomy: 'L0',
          scope: { kind: 'workspace', workspace_id: 'w1' },
        },
      ],
    })
    await service.interpret({ workspace_id: 'w1', graph })
    const shellCall = service.portCalls.find(
      (call) => call.method === 'dispatch' && call.args.calls?.some((c) => c.tool === 'shell'),
    )
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
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
          usage: {},
        }
      },
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result:
            call.tool === 'shell'
              ? { passed: false, detail: 'tests failed', exit_code: 1 }
              : { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    const graph = graphOf({
      nodes: [
        {
          node_id: 'vf-w1',
          contract_id: 'verify',
          impl: 'atomic',
          bindings: { command: 'npm test' },
          autonomy: 'L0',
          scope: { kind: 'workspace', workspace_id: 'w1' },
        },
      ],
    })
    const result = await service.interpret({
      turn_id: 't1',
      workspace_id: 'w1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
      graph,
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.ok(summary.iters >= 2, 'verify 失败应触发下一 iter')
    assert.ok(stepResults(service).length >= 1, '校验失败仍收口落盘助手步记录')
    assert.equal(settlesOf(service)[0].outcome.kind, 'committed')
    const modelMsgs = service.portCalls
      .filter((c) => c.port === 'model')
      .map((c) => c.args.messages)
    assert.ok(
      modelMsgs.some((msgs) =>
        msgs.some((m) => m.role === 'tool' && String(m.content).startsWith('verify:')),
      ),
      '报告应进下一 iter 上下文',
    )
  } finally {
    service.close()
  }
})

test('max_turn_iter 达上限仍派发 ⇒ committed + stop_reason（不是 refused）', async () => {
  let step = 0
  const service = startService({
    providers: {
      'model.chat': () => {
        step += 1
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: `c${step}`, name: 'edit', args: { path: 'a.txt' } }],
          usage: {},
        }
      },
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    const summary = summaryOf(result.value)
    // 用户预算停在步边界主动收口，保留已完成内容；只有真正的失败才是 refused。
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.equal(summary.outcome.kind, 'committed')
    assert.equal(summary.outcome.stop_reason, 'turn_iter')
    assert.equal(settlesOf(service).at(-1).outcome.stop_reason, 'turn_iter')
    assert.ok(stepResults(service).length > 0, '预算停不得丢弃已完成步骤')
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
    const contracts = seed.contracts.filter(
      (c) => c.contract_id === 'context.assemble' || c.contract_id === 'agent.step',
    )
    const nodes = [
      {
        node_id: 'as-assemble',
        contract_id: 'context.assemble',
        impl: 'atomic',
        entry: { cap: 'context', method: 'build' },
        scope: { kind: 'global' },
      },
      {
        node_id: 'step-a',
        contract_id: 'agent.step',
        impl: 'atomic',
        entry: { cap: 'model', method: 'chat' },
        bindings: { agent: 'agent-a' },
        scope: { kind: 'workspace', workspace_id: 'A' },
      },
      {
        node_id: 'step-b',
        contract_id: 'agent.step',
        impl: 'atomic',
        entry: { cap: 'model', method: 'chat' },
        bindings: { agent: 'agent-b' },
        scope: { kind: 'global' },
      },
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

test('门禁拒绝：deny 作工具结果回灌、回合继续（不是回合拒绝）', async () => {
  const service = startService({
    providers: {
      'model.chat': (args) => {
        const last = args.messages?.[args.messages.length - 1]
        if (last && last.role === 'tool')
          return { ok: true, text: '改用别的方案', tool_calls: [], usage: {} }
        return {
          ok: true,
          text: '先试着删目录',
          tool_calls: [{ id: 'c1', name: 'shell', args: { command: 'rm -rf /' } }],
          usage: {},
        }
      },
      'guard.judge': () => ({
        decisions: [{ index: 0, port: 'tool', tool: 'shell', verdict: 'deny' }],
        summary: { allow: 0, escalate: 0, deny: 1 },
      }),
    },
  })
  try {
    const result = await service.interpret({ turn_id: 't1' })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', 'deny 不再终结回合')
    assert.equal(summary.outcome.kind, 'committed')
    assert.ok(!portSequence(service).includes('tools.dispatch'), 'deny 不派发工具')
    assert.equal(settlesOf(service)[0].outcome.kind, 'committed')
    // 拒绝原因作为工具结果回灌：配对保住、助手正文不丢。
    const denied = stepResults(service).find((record) =>
      (record.tool_results ?? []).some(
        (item) => item.ok === false && item.error?.code === 'denied',
      ),
    )
    assert.ok(denied, '拒绝以工具结果形式落盘')
    const finalStep = stepResults(service).at(-1)
    assert.equal(finalStep.assistant.content, '改用别的方案', '助手正文未因拒绝被丢')
  } finally {
    service.close()
  }
})

test('提问往返：question 工具 ⇒ 段以 awaiting 收束、回合保持 open（不收口）', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [
          { id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } },
        ],
        usage: {},
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { status: 'pending' },
        })),
      }),
    },
  })
  try {
    const result = await service.interpret({})
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'pending', '提问是段终态 awaiting，不是回合终态')
    assert.equal(summary.pending, 'question')
    assert.equal(summary.iters, 1, '本段到此为止，不重入')
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
      if (last && last.role === 'tool')
        return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [
          { id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } },
        ],
        usage: {},
      }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({
        call_id: call.call_id,
        ok: true,
        result: { status: 'pending' },
      })),
    }),
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
    const result = await second.interpret({
      resume: { cursor, thread: 't1', payload: { answers: [{ id: 'x', answer: 'yes' }] } },
    })
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
        argsSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
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
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
          usage: {},
        }
      },
      'tool-fs.invoke': (args) => ({ ok: true, result: { path: args.args.path } }),
    },
  })
  try {
    const result = await service.interpret({ tools_bindings: { bindings: {} }, mcp_tools: [] })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const seq = portSequence(service).filter((key) => !key.startsWith('graph-gate.'))
    assert.equal(seq[0], 'tools.list', 'context.assemble 前应取目录')
    assert.equal(seq.filter((key) => key === 'tools.list').length, 1, '目录只取一次（重入复用）')
    const contextCall = service.portCalls.find(
      (call) => call.port === 'context' && call.method === 'build',
    )
    assert.equal(contextCall.args.tools.length, 1, 'context.build 应收到非空目录')
    const firstModel = service.portCalls.find((call) => call.port === 'model')
    assert.equal(firstModel.args.tools.length, 1, '模型应看到非空工具目录')
    assert.equal(firstModel.args.tools[0].name, 'edit')
    const dispatchCall = service.portCalls.find(
      (call) => call.port === 'tools' && call.method === 'dispatch',
    )
    assert.ok(dispatchCall, '应派发工具')
    assert.equal(dispatchCall.args.directory.tools.length, 1, 'tool.dispatch 复用同一目录')
    assert.equal(dispatchCall.args.tools.length, 1)
    assert.equal(
      dispatchCall.args.calls[0].port,
      'tool-fs',
      '(port, tool) 判据用目录解析出的提供者',
    )
  } finally {
    service.close()
  }
})

test('patchQuestionAnswer：派发后游标只替换 question 项，保留同批其它真实结果', () => {
  const iter = {
    outputs: new Map([
      [
        4,
        {
          results: [
            { call_id: 'e1', ok: true, result: { marker: 'edit-real' } },
            { call_id: 'q1', ok: true, result: { status: 'pending' } },
          ],
        },
      ],
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

test('提问续跑：游标取派发前（不含本批产出），同批其它工具真实结果经步记录回灌模型', async () => {
  const seen = []
  const providers = {
    'tools.list': () => ({ tools: [], rejected: [] }),
    'model.chat': (args) => {
      seen.push(Array.isArray(args.messages) ? JSON.parse(JSON.stringify(args.messages)) : [])
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool')
        return { ok: true, text: 'answered', tool_calls: [], usage: {} }
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
          ? { call_id: call.call_id, ok: true, result: { status: 'pending' } }
          : { call_id: call.call_id, ok: true, result: { path: 'a.txt', marker: 'edit-real' } },
      ),
    }),
  }
  const service = startService({ providers })
  try {
    const first = await service.interpret({ turn_id: 't1', input: { content: 'orig' } })
    const cursor = service.portCalls.find(
      (call) => call.port === 'tools' && call.method === 'dispatch',
    )?.args?.cursor
    assert.ok(cursor, 'question 派发应带续跑游标')
    assert.equal(cursor.kind, 'question')
    assert.equal(
      JSON.stringify(cursor.outputs ?? {}).includes('edit-real'),
      false,
      '游标取派发前，不含本批真实产出',
    )
    const result = await service.interpret({
      turn_id: 't1',
      input: { content: 'orig' },
      resume: {
        cursor,
        thread: 't1',
        payload: { answers: [{ question_id: 'x', selected: ['yes'] }] },
      },
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.iters, 2, '答案回灌后应重入一次')
    const fed = seen
      .at(-1)
      ?.find((message) => message.role === 'tool' && String(message.content).includes('edit-real'))
    assert.ok(fed, '同批其它工具真实结果须经步记录回灌模型')
    // 作答步原位覆盖 pending 结果，不再多插 assistant(tool_calls) 帧（否则严格 provider 会因重复调用 / 无配对结果拒绝）。
    const last = seen.at(-1) ?? []
    assert.equal(
      last.filter((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
        .length,
      1,
      '续跑重建不应重复助手 tool_calls 帧',
    )
    const q1 = last.find((message) => message.role === 'tool' && message.tool_call_id === 'q1')
    assert.ok(q1 !== undefined && String(q1.content).includes('yes'), 'q1 工具结果应为 answers')
  } finally {
    service.close()
  }
})

test('提问续跑：作答步 seq 取该回合已落步记录之后，不与悬挂 / 挂起步同键', async () => {
  const providers = {
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool')
        return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [
          { id: 'q1', name: 'question', args: { questions: [{ id: 'x', question: 'which?' }] } },
        ],
        usage: {},
      }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({
        call_id: call.call_id,
        ok: true,
        result: { status: 'pending' },
      })),
    }),
  }
  const service = startService({ providers })
  try {
    const first = await service.interpret({ turn_id: 't1', input: { content: 'orig' } })
    assert.equal(summaryOf(first.value).ended, 'pending')
    // 该回合首段已落步记录（含悬挂派发步与挂起收口步）：模拟 session.read 的 turns[].steps。
    const recorded = service.portCalls
      .filter((call) => call.port === 'session' && call.method === 'step_append')
      .map((call) => call.args)
    assert.ok(recorded.length > 0, '首段应落步记录')
    const hangMax = Math.max(...recorded.map((record) => record.seq))
    const cursor = service.portCalls.find(
      (call) => call.port === 'tools' && call.method === 'dispatch',
    )?.args?.cursor
    const before = service.portCalls.filter(
      (call) => call.port === 'session' && call.method === 'step_append',
    ).length
    const result = await service.interpret({
      turn_id: 't1',
      input: { content: 'orig' },
      session: { turns: [{ turn_id: 't1', steps: recorded }] },
      resume: {
        cursor,
        thread: 't1',
        payload: { answers: [{ question_id: 'x', selected: ['yes'] }] },
      },
    })
    assert.equal(summaryOf(result.value).ended, 'done')
    const appended = service.portCalls
      .filter((call) => call.port === 'session' && call.method === 'step_append')
      .slice(before)
      .map((call) => call.args)
    const answerStep = appended.find(
      (record) =>
        record.type === 'step.result' &&
        Array.isArray(record.tool_results) &&
        record.tool_results.some((item) => item.result?.answers),
    )
    assert.ok(answerStep, '作答步应落盘')
    assert.ok(
      answerStep.seq > hangMax,
      `作答步 seq 应在该回合已落步之后：${answerStep.seq} > ${hangMax}`,
    )
  } finally {
    service.close()
  }
})

test('resume 保留原始 bag.input：作答时刻槽已是 question.answer 也不丢原用户消息', async () => {
  const queueDirective = (cursor) => ({
    kind: 'write',
    request: {
      op: 'batch',
      args: {
        ops: [
          {
            op: 'put',
            args: {
              body: {
                id: 'q-item',
                resume: { command: 'chat.resume', args: { cursor, thread: 't1' } },
              },
            },
          },
        ],
      },
    },
  })
  const providers = {
    'tools.list': () => ({ tools: [], rejected: [] }),
    'model.chat': (args) => {
      const last = args.messages?.[args.messages.length - 1]
      if (last && last.role === 'tool')
        return { ok: true, text: 'answered', tool_calls: [], usage: {} }
      return {
        ok: true,
        text: '',
        tool_calls: [{ id: 'q1', name: 'question', args: {} }],
        usage: {},
      }
    },
    'tools.dispatch': (args) => ({
      results: args.calls.map((call) => ({
        call_id: call.call_id,
        ok: true,
        result: { status: 'pending', $directives: [queueDirective(args.cursor)] },
      })),
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
    await second.interpret({
      input: { content: '' },
      resume: { cursor, thread: 't1', payload: { answers: [{ id: 'x', answer: 'yes' }] } },
    })
    const contextCall = second.portCalls.find(
      (call) => call.port === 'context' && call.method === 'build',
    )
    assert.equal(contextCall.args.input.content, '原始用户消息', '恢复应优先用游标内原始输入')
  } finally {
    second.close()
  }
})

test('并发 interpret：两次调用各用自己的工具目录解析提供者（无跨调用共享状态）', async () => {
  const guardPorts = []
  let markBCalled
  const bCalled = new Promise((resolve) => {
    markBCalled = resolve
  })
  const service = startService({
    providers: {
      'context.build': (args) => {
        const extra = Array.isArray(args.extra_messages) ? args.extra_messages : []
        return { messages: [{ role: 'user', content: 'hi' }, ...extra], params: {} }
      },
      'model.chat': async (args) => {
        const last = Array.isArray(args.messages) ? args.messages[args.messages.length - 1] : null
        if (last && last.role === 'tool')
          return { ok: true, text: 'done', tool_calls: [], usage: {} }
        if (args.config?.model === 'model-A') {
          // A 的首次模型调用等到 B 也进了模型调用才返回，确保两次 round 的派发窗口重叠。
          await bCalled
          return {
            ok: true,
            text: '',
            tool_calls: [{ id: 'c-a', name: 'edit', args: {} }],
            usage: {},
          }
        }
        markBCalled()
        return {
          ok: true,
          text: '',
          tool_calls: [{ id: 'c-b', name: 'edit', args: {} }],
          usage: {},
        }
      },
      'guard.judge': (args) => {
        for (const call of args.calls) guardPorts.push(call.port)
        const decisions = args.calls.map((call, index) => ({
          index,
          port: call.port,
          tool: call.tool,
          verdict: 'allow',
        }))
        return { decisions, summary: { allow: decisions.length, escalate: 0, deny: 0 } }
      },
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: {} })),
      }),
    },
  })
  try {
    await service.hello()
    const bagA = {
      turn_id: 't-a',
      config: { model: 'model-A' },
      tools: [{ name: 'edit', provider: 'provider-A' }],
    }
    const bagB = {
      turn_id: 't-b',
      config: { model: 'model-B' },
      tools: [{ name: 'edit', provider: 'provider-B' }],
    }
    const [ra, rb] = await Promise.all([service.interpret(bagA), service.interpret(bagB)])
    assert.equal(ra.kind, 'result', JSON.stringify(ra))
    assert.equal(rb.kind, 'result', JSON.stringify(rb))
    assert.equal(guardPorts.length, 2)
    assert.deepEqual(
      [...guardPorts].sort(),
      ['provider-A', 'provider-B'],
      `提供者解析串台：${JSON.stringify(guardPorts)}`,
    )
  } finally {
    service.close()
  }
})

test('dispatchBag 透传 grant：#27 收到一次性 caps.grant', async () => {
  const service = startService({
    providers: {
      'model.chat': () => ({
        ok: true,
        text: '',
        tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }],
        usage: {},
      }),
      'tools.dispatch': (args) => ({
        results: args.calls.map((call) => ({
          call_id: call.call_id,
          ok: true,
          result: { path: 'a.txt' },
        })),
      }),
    },
  })
  try {
    await service.interpret({
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
      grant: { call_id: 'c1', tier: 'severe' },
    })
    const dispatchCall = service.portCalls.find(
      (call) => call.port === 'tools' && call.method === 'dispatch',
    )
    assert.deepEqual(dispatchCall.args.grant, { call_id: 'c1', tier: 'severe' })
  } finally {
    service.close()
  }
})

test('同回合产 trace + verdict：合并为单世代，补丁 def 同时含新 trace 与新 verdicts', async () => {
  const seed = seedModel()
  const candidate = JSON.parse(JSON.stringify(seed.graph))
  const graphHash = H(candidate)
  const proposal = {
    kind: 'proposal',
    id: 'pr-1',
    class: 'structure',
    evidence_ids: [],
    target: { graph: { def: graphHash }, contract_id: null, node_id: null },
    patch: { def: graphHash, graph: { def: graphHash }, writes: [] },
    by: 'evolve-loop',
    at: '2026-09-20T00:00:00.000Z',
    prev: null,
  }
  const proposalHash = H(proposal)
  const evolution = {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: { def: proposalHash }, count: 1 },
    verdicts: { tail: null, count: 0 },
    data_gen: { seq: 4, payload: 'a'.repeat(64) },
  }
  const bag = {
    graph: {
      contracts: seed.contracts,
      nodes: seed.nodes,
      prompts: seed.prompts,
      graph: seed.graph,
      thresholds: seed.thresholds,
      refusal_codes: seed.refusalCodes,
    },
    evolution,
    refs: { [graphHash]: candidate, [proposalHash]: proposal },
  }
  const service = startService()
  try {
    const result = await service.interpret(bag)
    const batch = writeBatches(result.value).find((ops) =>
      ops.some((op) => op.op === 'add_gen' && op.args.id === 'evolution'),
    )
    assert.ok(batch, '应产 evolution 世代')
    const addGens = batch.filter((op) => op.op === 'add_gen' && op.args.id === 'evolution')
    assert.equal(addGens.length, 1, '同回合只新增一个世代')
    assert.equal(addGens[0].args.base, 4, 'base 指向回合初数据世代')
    const patchPut = batch.find((op) => op.op === 'put' && op.args.body?.ops !== undefined)
    assert.ok(patchPut, '补丁世代应写补丁 def')
    const paths = patchPut.args.body.ops.map((patch) => patch.path[0])
    assert.ok(paths.includes('trace'), '补丁含新 trace 槽')
    assert.ok(paths.includes('verdicts'), '补丁含新 verdicts 槽')
  } finally {
    service.close()
  }
})
