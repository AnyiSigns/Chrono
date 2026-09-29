// 段边界检查点：上下文压力越阈时经 compress.summarize 写结构化 checkpoint 步记录（有模型连接走
// semantic 图外压缩，否则回落 algorithmic）；喂整段会话切片（含工具结果）；未越阈不写；
// 压缩失败只跳过记录、不阻断续段（回合仍收口）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService, portError } from './driver.mjs'
import { checkpointLevel, checkpointThresholds, contextPressure } from '../execute/checkpoint.ts'

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

/** 一次「派发工具 → 段边界 → 无工具收口」的两段回合。 */
function loopProviders(overrides = {}) {
  let chatCalls = 0
  return {
    'context.build': () => ({
      messages: [{ role: 'user', content: 'hi' }],
      params: { model: 'm' },
      manifest: { budget: 1000, used: 800 },
    }),
    'model.chat': () => {
      chatCalls += 1
      if (chatCalls === 1) return { ok: true, text: '', tool_calls: [{ id: 'c1', name: 'edit', args: { path: 'a.txt' } }], usage: {} }
      return { ok: true, text: 'done', tool_calls: [], usage: {} }
    },
    'guard.judge': () => ({ decisions: [{ index: 0, port: 'tool', tool: 'edit', verdict: 'allow' }], summary: { allow: 1, escalate: 0, deny: 0 } }),
    'tools.dispatch': (args) => ({ results: args.calls.map((call) => ({ call_id: call.call_id, ok: true, result: { path: 'a.txt' } })) }),
    ...overrides,
  }
}

/** 结构化检查点（段标记 / verify 报告带内部 `kind`，不算）。 */
function checkpointRecords(service) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'step_append')
    .map((call) => call.args)
    .filter((args) => args?.type === 'checkpoint' && args.summary?.kind === undefined)
}

test('越软阈：段边界写结构化检查点（compress 为后端，persist:false），回合照常收口', async () => {
  const compressArgs = []
  const service = startService({
    providers: loopProviders({
      'compress.summarize': (args) => {
        compressArgs.push(args)
        return {
          ok: true,
          kind: 'summarize',
          summary: { goal: '修复 foo', decisions: ['只读投影'], facts: ['缺陷在 foo.ts:42'], open_questions: [], files: args.files, next_steps: [] },
        }
      },
    }),
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      input: '修复 foo',
      workspace_id: 'w1',
      l1: { goal: '修复 foo' },
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.equal(compressArgs.length, 1, '须在段边界调用一次 compress.summarize')
    assert.equal(compressArgs[0].mode, 'algorithmic', '无模型连接时回落 algorithmic')
    assert.equal(compressArgs[0].persist, false, '检查点只算不写')
    assert.deepEqual(
      compressArgs[0].session_slice.slice(0, 2),
      [
        { role: 'user', content: '修复 foo' },
        { role: 'tool', content: JSON.stringify({ call_id: 'c1', ok: true, result: { path: 'a.txt' } }) },
      ],
      '整段会话切片含本回合工具结果（不只助手正文）',
    )

    const records = checkpointRecords(service)
    assert.equal(records.length, 1, '应写一条结构化检查点')
    const record = records[0]
    assert.equal(typeof record.turn_id, 'string')
    assert.deepEqual(record.covered_upto, { turn_id: 't1', seq: record.seq - 1 }, '全局边界 {turn_id, seq}')
    assert.equal(record.covered_upto.seq > 0, true)
    assert.equal(record.rung, 'soft')
    assert.equal(record.summary.goal, '修复 foo')
    assert.deepEqual(record.summary.findings, [{ claim: '缺陷在 foo.ts:42' }], 'facts 须映射成 findings')
    assert.deepEqual(record.summary.files, [{ path: 'a.txt' }], '本回合触达文件随检查点落账')
  } finally {
    service.close()
  }
})

test('图外 semantic 压缩：有 config 时经独立模型连接压缩，整段切片含往期工具结果', async () => {
  const compressArgs = []
  const config = { vendor: 'v', model: 'm', params: {} }
  const service = startService({
    providers: loopProviders({
      'compress.summarize': (args) => {
        compressArgs.push(args)
        return {
          ok: true,
          kind: 'summarize',
          summary: { goal: 'g', decisions: [], facts: ['f'], open_questions: [], files: args.files, next_steps: [] },
        }
      },
    }),
  })
  try {
    await service.interpret({
      turn_id: 't1',
      input: '继续',
      config,
      workspace_id: 'w1',
      session: {
        turns: [
          {
            turn_id: 't0',
            user_message: { content: '上一问' },
            steps: [
              { type: 'step.intent', turn_id: 't0', seq: 1, kind: 'tool.dispatch', tool_calls: [{ id: 'p1', name: 'read', arguments: { path: 'x' } }] },
              { type: 'step.result', turn_id: 't0', seq: 1, assistant: { content: '上一答' }, tool_results: [{ call_id: 'p1', ok: true, result: 'XCONTENT' }] },
            ],
          },
        ],
      },
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    assert.equal(compressArgs.length, 1)
    assert.equal(compressArgs[0].mode, 'semantic', '有模型连接走图外 semantic 压缩')
    assert.deepEqual(compressArgs[0].model_config, config, '独立模型连接原样透传')
    assert.deepEqual(
      compressArgs[0].session_slice.slice(0, 3),
      [
        { role: 'user', content: '上一问' },
        { role: 'assistant', content: '上一答' },
        { role: 'tool', content: JSON.stringify('XCONTENT') },
      ],
      '往期回合连工具结果一并进整段切片',
    )
  } finally {
    service.close()
  }
})

test('滚动累计：上一结构化检查点作为 prior_summary 先并入，全局边界指向本回合', async () => {
  const compressArgs = []
  const prior = {
    goal: '上一目标',
    decisions: [{ what: '只读投影' }],
    findings: [{ claim: '旧缺陷' }],
    errors_to_avoid: [{ what: '旧错误' }],
    covered_upto: { turn_id: 't0', seq: 2 },
  }
  const service = startService({
    providers: loopProviders({
      'compress.summarize': (args) => {
        compressArgs.push(args)
        const previous = args.prior_summary ?? {}
        return {
          ok: true,
          kind: 'summarize',
          summary: {
            goal: '本轮目标',
            decisions: [...(previous.decisions ?? []), '本轮决策'],
            facts: [...(previous.facts ?? []), '本轮事实'],
            open_questions: [],
            files: args.files,
            next_steps: [],
          },
        }
      },
    }),
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      input: '继续',
      workspace_id: 'w1',
      session: { turns: [{ turn_id: 't0', steps: [{ type: 'checkpoint', turn_id: 't0', seq: 3, summary: prior, covered_upto: { turn_id: 't0', seq: 2 } }] }] },
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    assert.equal(summaryOf(result.value).ended, 'done')
    assert.equal(compressArgs.length, 1)
    assert.deepEqual(compressArgs[0].prior_summary, {
      goal: '上一目标',
      decisions: ['只读投影'],
      facts: ['旧缺陷'],
    }, '上一累计检查点先并入')
    const record = checkpointRecords(service)[0]
    assert.equal(record.summary.goal, '本轮目标')
    assert.deepEqual(record.summary.decisions, [{ what: '只读投影' }, { what: '本轮决策' }], '累计保留上一决策 + 本轮')
    assert.deepEqual(record.summary.findings, [{ claim: '旧缺陷' }, { claim: '本轮事实' }], '累计保留上一发现 + 本轮')
    assert.deepEqual(record.summary.errors_to_avoid, [{ what: '旧错误' }], 'compress 形状不承载的字段原样承接')
    assert.deepEqual(record.covered_upto, { turn_id: 't1', seq: record.seq - 1 }, '全局边界指向本回合')
  } finally {
    service.close()
  }
})

test('压缩失败：只跳过检查点记录，不阻断续段，回合仍收口', async () => {
  let attempts = 0
  const service = startService({
    providers: loopProviders({
      'compress.summarize': () => {
        attempts += 1
        return portError('transport_failed', 'compress down')
      },
    }),
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      input: '修复 foo',
      workspace_id: 'w1',
      tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }],
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.equal(attempts, 1, '应尝试压缩一次')
    assert.equal(checkpointRecords(service).length, 0, '失败不得写检查点记录')
    // 段标记仍落账：续段不因检查点失败而中断。
    const marks = service.portCalls
      .filter((call) => call.port === 'session' && call.method === 'step_append')
      .map((call) => call.args)
      .filter((args) => args?.type === 'checkpoint' && args.summary?.kind === 'segment')
    assert.equal(marks.length >= 1, true, '段标记须照常落账')
  } finally {
    service.close()
  }
})

test('档位判定：软 / 硬 / 应急三档，bag.checkpoint_thresholds 可覆盖', () => {
  const model = { thresholds: { checkpoint_soft_ratio: 0.7, checkpoint_hard_ratio: 0.85, checkpoint_emergency_ratio: 0.95 } }
  const thresholds = checkpointThresholds(model, {})
  assert.equal(checkpointLevel(0.69, thresholds), null)
  assert.equal(checkpointLevel(0.7, thresholds), 'soft')
  assert.equal(checkpointLevel(0.85, thresholds), 'hard')
  assert.equal(checkpointLevel(0.95, thresholds), 'emergency')
  const override = checkpointThresholds(model, { checkpoint_thresholds: { soft: 0.5 } })
  assert.equal(override.soft, 0.5)
  assert.equal(override.hard, 0.85)
})

test('压力：缺清单 / 预算非正不触发', () => {
  assert.equal(contextPressure({ shared: {} }), null)
  assert.equal(contextPressure({ shared: { context_manifest: { used: 5, budget: 0 } } }), null)
  assert.equal(contextPressure({ shared: { context_manifest: { used: 5, budget: 10 } } }).ratio, 0.5)
})

test('未越软阈：不调用 compress，不写检查点', async () => {
  let compressCalls = 0
  const service = startService({
    providers: loopProviders({
      'context.build': () => ({
        messages: [{ role: 'user', content: 'hi' }],
        params: { model: 'm' },
        manifest: { budget: 1000, used: 500 },
      }),
      'compress.summarize': () => {
        compressCalls += 1
        return { ok: true, kind: 'summarize', summary: { goal: 'x', facts: ['y'] } }
      },
    }),
  })
  try {
    const result = await service.interpret({ turn_id: 't1', workspace_id: 'w1', tools: [{ name: 'edit', provider: 'tool', caps: { fs: { write: 'workspace' } } }] })
    assert.equal(summaryOf(result.value).ended, 'done')
    assert.equal(compressCalls, 0, '压力 0.5 低于软阈 0.7 不应触发')
    assert.equal(checkpointRecords(service).length, 0)
  } finally {
    service.close()
  }
})
