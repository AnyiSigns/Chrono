// 段边界检查点：上下文压力越阈时经 compress.summarize 写结构化 checkpoint 步记录；
// 未越阈不写；压缩失败只跳过记录、不阻断续段（回合仍收口）。
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
    assert.equal(compressArgs[0].mode, 'algorithmic')
    assert.equal(compressArgs[0].persist, false, '检查点只算不写')
    assert.deepEqual(compressArgs[0].session_slice, [{ role: 'user', content: '修复 foo' }])

    const records = checkpointRecords(service)
    assert.equal(records.length, 1, '应写一条结构化检查点')
    const record = records[0]
    assert.equal(typeof record.turn_id, 'string')
    assert.equal(typeof record.covered_upto, 'number')
    assert.equal(record.covered_upto > 0, true)
    assert.equal(record.rung, 'soft')
    assert.equal(record.summary.goal, '修复 foo')
    assert.deepEqual(record.summary.findings, [{ claim: '缺陷在 foo.ts:42' }], 'facts 须映射成 findings')
    assert.deepEqual(record.summary.files, [{ path: 'a.txt' }], '本回合触达文件随检查点落账')
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
