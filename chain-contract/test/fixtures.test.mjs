// 共享夹具与契约不变量测试：夹具形状可校验，bag 键差集已登记，码透传与封闭集成立。

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertBagSingleSource,
  assertCausePassthrough,
  assertOutcomeClosed,
  assertValidBag,
  assertValidStepRecord,
  diffBagKeys,
} from '../invariants.ts'
import {
  validateReasoningBlock,
  validateRetrievalSearchBag,
} from '../src/runtime.ts'
import {
  interpretBag,
  nodeIo,
  outcomeFixtures,
  retrievalSearch,
  sessionSlices,
  stepRecords,
  vendorReasoning,
} from '../fixtures/index.ts'

// 生产方 = buildInterpretBag 与 chat 方法写出的键；消费方 = loop-policy 读取的键。
const PRODUCER_KEYS = [
  'input',
  'input_body',
  'config',
  'thread',
  'thread_kind',
  'session',
  'tier',
  'session_id',
  'memories',
  'graph',
  'evidence',
  'evolution',
  'approval',
  'question',
  'todo',
  'guard_rules',
  'sandbox_tiers',
  'tools_bindings',
  'mcp_tools',
  'persona',
  'skills',
  'style',
  'system_prompt',
  'tools',
  'recall',
  'workspace_id',
  'workspace_root',
  'new_conversation',
  'resume',
]

const CONSUMER_KEYS = [
  'append_commit',
  'approval',
  'budget',
  'config',
  'cursor',
  'directory',
  'evolution',
  'graph',
  'graph_refs',
  'grant',
  'guard_rules',
  'input',
  'input_body',
  'mcp_tools',
  'memories',
  'new_conversation',
  'now',
  'persona',
  'pins',
  'projection_reads',
  'queue',
  'question',
  'recall',
  'refs',
  'resilience',
  'resume',
  'runs_since_fork',
  'sandbox_tiers',
  'session',
  'session_id',
  'skills',
  'skills_select',
  'slots',
  'style',
  'system_prompt',
  'task',
  'thread',
  'thread_kind',
  'tier',
  'todo',
  'tool_choice',
  'tools',
  'tools_bindings',
  'workspace_id',
  'workspace_root',
]

// 已登记的契约缺口：消费方读取但 schema / 生产方未覆盖的键（含执行中内部键与待接线键）。
const REGISTERED_CONSUMER_GAPS = [
  'append_commit',
  'budget',
  'cursor',
  'directory',
  'grant',
  'graph_refs',
  'now',
  'pins',
  'projection_reads',
  'queue',
  'refs',
  'resilience',
  'runs_since_fork',
  'skills_select',
  'slots',
  'task',
  'tool_choice',
]

test('夹具：interpret bag 通过校验（含严格模式）', () => {
  assertValidBag(interpretBag, true)
  assert.ok(interpretBag['contract_version'] === '1.0')
})

test('夹具：五种步记录均可校验', () => {
  assert.equal(stepRecords.length, 5)
  for (const record of stepRecords) assertValidStepRecord(record)
})

test('夹具：session 切片与节点 IO 形状齐备', () => {
  assert.ok(typeof sessionSlices['session'] === 'object')
  assert.ok(typeof sessionSlices['slice']['head'] === 'string')
  for (const node of ['context.assemble', 'model.chat', 'tool.gate', 'tool.dispatch', 'turn.commit', 'recall']) {
    assert.ok(nodeIo[node] !== undefined, `missing node ${node}`)
    assert.ok(typeof nodeIo[node]['input'] === 'object')
    assert.ok(typeof nodeIo[node]['output'] === 'object')
  }
})

test('I5：每类结局封闭，下游码经 cause 原样透传', () => {
  assert.ok(outcomeFixtures.length >= 10)
  const labels = new Set()
  for (const fixture of outcomeFixtures) {
    assert.ok(!labels.has(fixture.label), `duplicate label ${fixture.label}`)
    labels.add(fixture.label)
    assertOutcomeClosed(fixture.outcome)
  }
  const tool = outcomeFixtures.find((fixture) => fixture.label === 'refused-tool')
  assert.ok(tool !== undefined)
  assertCausePassthrough(tool.outcome, 'not_found')
  const model = outcomeFixtures.find((fixture) => fixture.label === 'refused-model')
  assert.ok(model !== undefined)
  assertCausePassthrough(model.outcome, 'model_timeout')
})

test('I6：bag 键差集与已登记缺口一致', () => {
  const diff = diffBagKeys({ producerKeys: PRODUCER_KEYS, consumerKeys: CONSUMER_KEYS })
  assert.deepEqual(diff.schemaUnknownProducer, [])
  assert.deepEqual(diff.producerOnly, ['evidence'])
  assert.deepEqual(diff.consumerOnly, REGISTERED_CONSUMER_GAPS)
  assert.deepEqual(diff.schemaUnknownConsumer, REGISTERED_CONSUMER_GAPS)
  assertBagSingleSource(diff, {
    schemaUnknownProducer: [],
    schemaUnknownConsumer: REGISTERED_CONSUMER_GAPS,
    consumerOnly: REGISTERED_CONSUMER_GAPS,
  })
})

test('I6：未登记的消费方键会失败', () => {
  assert.throws(() =>
    assertBagSingleSource(
      diffBagKeys({ producerKeys: PRODUCER_KEYS, consumerKeys: [...CONSUMER_KEYS, 'brand_new_key'] }),
      {
        schemaUnknownProducer: [],
        schemaUnknownConsumer: REGISTERED_CONSUMER_GAPS,
        consumerOnly: REGISTERED_CONSUMER_GAPS,
      },
    ),
  )
})

test('retrieval.search 夹具：权威键可校验，生产方已对齐，键名漂移留历史档', () => {
  assert.equal(validateRetrievalSearchBag(retrievalSearch['authoritative']).ok, true)
  assert.equal(retrievalSearch['authoritative']['workspace'], 'w-1')
  assert.equal(retrievalSearch['authoritative']['recall_budget'], 8)
  // 生产方当前形状：已按权威键名发出。
  assert.equal(retrievalSearch['producer_current']['workspace'], 'w-1')
  assert.equal(retrievalSearch['producer_current']['recall_budget'], 8)
  assert.equal(retrievalSearch['producer_current']['query'], '看看 foo.ts 第 42 行')
  assert.equal(Object.hasOwn(retrievalSearch['producer_current'], 'workspace_id'), false)
  assert.equal(Object.hasOwn(retrievalSearch['producer_current'], 'budget'), false)
  // 历史档：明确标注 historical，逐项记录修复前后的键名，不得读作当前形状。
  const drift = retrievalSearch['producer_drift_historical']
  assert.equal(drift['status'], 'historical')
  assert.equal(drift['items'].length, 3)
  for (const item of drift['items']) {
    assert.equal(item['producer_key_after'], item['authoritative_key'])
    assert.equal(typeof item['producer_key_before'], 'string')
  }
})

test('厂商推理夹具逐块可校验', () => {
  for (const [vendor, block] of Object.entries(vendorReasoning)) {
    assert.equal(validateReasoningBlock(block).ok, true, `vendor ${vendor} block invalid`)
  }
})
