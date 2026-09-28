// 子代理隔离：上下文 = 任务 + 父检查点（不是父消息历史），返回结构化结果（不是子代理全程记录）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'

function subagentGraph() {
  const seed = seedModel()
  return {
    contracts: seed.contracts,
    nodes: seed.nodes,
    prompts: seed.prompts,
    graph: {
      nodes: ['subagent', 'turn.commit'],
      edges: [{ from: [0, 'message'], to: [1, 'message'] }],
      entry_supply: [{ type_id: 'task', role: 'task' }],
      loop: { when: '', max_iter: 'max_turn_iter' },
      sink: 1,
    },
    thresholds: seed.thresholds,
    refusal_codes: seed.refusalCodes,
  }
}

const RESULT_JSON = JSON.stringify({
  goal: 'SUBAGENT-GOAL',
  findings: [{ claim: 'FINDING-1' }],
  files: [{ path: 'src/a.ts' }],
  open_questions: ['OPEN-1'],
})

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function stepRecords(service) {
  return service.portCalls
    .filter((call) => call.port === 'session' && call.method === 'step_append')
    .map((call) => call.args)
}

test('子代理上下文 = 任务 + 父检查点（不含父消息历史），返回结构化结果', async () => {
  const modelCalls = []
  const service = startService({
    providers: {
      'model.chat': (args) => {
        modelCalls.push(args)
        return { ok: true, text: RESULT_JSON, tool_calls: [], usage: {} }
      },
    },
  })
  try {
    const result = await service.interpret({
      turn_id: 't1',
      task: 'DELEGATED-TASK',
      input: 'PARENT-USER-MESSAGE',
      session: {
        turns: [
          {
            turn_id: 't1',
            steps: [
              {
                type: 'checkpoint',
                turn_id: 't1',
                seq: 2,
                summary: { goal: 'PARENT-GOAL', findings: [{ claim: 'PARENT-FINDING' }] },
                covered_upto: 2,
              },
            ],
          },
        ],
      },
      graph: subagentGraph(),
    })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))

    // 上下文只含任务 + 父检查点，父消息历史不得进入。
    assert.equal(modelCalls.length, 1)
    const call = modelCalls[0]
    const texts = call.messages.map((message) => message.content)
    assert.ok(texts.includes('DELEGATED-TASK'), '任务应进入子代理上下文')
    assert.ok(
      texts.some((text) => typeof text === 'string' && text.includes('[父检查点]') && text.includes('PARENT-GOAL')),
      `父检查点应渲染进上下文: ${JSON.stringify(texts)}`,
    )
    assert.ok(
      !texts.some((text) => typeof text === 'string' && text.includes('PARENT-USER-MESSAGE')),
      '父消息历史不得进入子代理上下文',
    )
    assert.equal(call.thread_kind, 'subagent')
    assert.equal(call.parent_checkpoint.summary.goal, 'PARENT-GOAL')

    // 返回结构化结果：落一条 checkpoint 步记录，而非子代理全程记录。
    const checkpoints = stepRecords(service).filter(
      (args) => args?.type === 'checkpoint' && args.summary?.goal === 'SUBAGENT-GOAL',
    )
    assert.equal(checkpoints.length, 1, '子代理结构化结果应落一条 checkpoint 步记录')
    assert.deepEqual(checkpoints[0].summary.findings, [{ claim: 'FINDING-1' }])
    assert.deepEqual(checkpoints[0].summary.files, [{ path: 'src/a.ts' }])
    assert.deepEqual(checkpoints[0].summary.open_questions, ['OPEN-1'])
  } finally {
    service.close()
  }
})
