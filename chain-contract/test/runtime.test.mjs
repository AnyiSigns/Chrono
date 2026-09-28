// 契约运行子集单测：校验收 / 拒绝、版本拒绝、结局构造、码集封闭、步记录、自包含。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  ATTRIBUTABLE_TO,
  CONTRACT_MAJOR,
  CONTRACT_VERSION,
  INTERPRET_BAG_KEYS,
  OUTCOME_CODES,
  OUTCOME_KINDS,
  RETRIEVAL_SEARCH_KEYS,
  causeFromError,
  causeOf,
  cancelled,
  checkContractVersion,
  committed,
  interrupted,
  isAttributableTo,
  isOutcomeCode,
  refused,
  validateBag,
  validateOutcome,
  validateReasoningBlock,
  validateRetrievalSearchBag,
  validateStepRecord,
} from '../src/runtime.ts'

const RUNTIME_URL = new URL('../src/runtime.ts', import.meta.url)

test('封闭集取值与去重', () => {
  assert.deepEqual([...ATTRIBUTABLE_TO], [
    'model',
    'tool',
    'guard',
    'approval',
    'graph',
    'owner',
    'transport',
    'budget',
  ])
  for (const code of [
    'model_not_configured',
    'workspace_missing',
    'empty_slot',
    'no_plan',
    'owner_unavailable',
    'turn_busy',
    'loop_unavailable',
    'budget_exceeded',
    'budget_impossible',
    'interrupted',
    'cancelled',
    'too_many_rounds',
    'model_timeout',
    'capability_mismatch',
    'downstream_refusal',
    'transport_failed',
    'contract_version_mismatch',
    'invalid_contract',
  ]) {
    assert.ok(OUTCOME_CODES.includes(code), `missing outcome code ${code}`)
  }
  assert.equal(new Set(OUTCOME_CODES).size, OUTCOME_CODES.length)
  assert.equal(new Set(ATTRIBUTABLE_TO).size, ATTRIBUTABLE_TO.length)
  assert.ok(OUTCOME_KINDS.includes('committed') && OUTCOME_KINDS.includes('interrupted'))
  assert.ok(isOutcomeCode('no_plan') && !isOutcomeCode('pre_unsat'))
  assert.ok(isAttributableTo('owner') && !isAttributableTo('user'))
})

test('版本校验：主版本一致通过，未知主版本显式拒绝', () => {
  assert.equal(CONTRACT_VERSION, `${CONTRACT_MAJOR}.0`)
  assert.deepEqual(checkContractVersion('1.0'), { ok: true, value: '1.0' })
  assert.deepEqual(checkContractVersion('1.7'), { ok: true, value: '1.7' })
  const mismatch = checkContractVersion('2.0')
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.outcome.code, 'contract_version_mismatch')
  assert.equal(mismatch.outcome.kind, 'refused')
  assert.equal(checkContractVersion('x').ok, false)
  assert.equal(checkContractVersion(undefined).ok, false)
  assert.equal(checkContractVersion(null).ok, false)
})

test('结局构造器与校验', () => {
  const ok = validateOutcome(committed({ stopReason: 'budget' }))
  assert.ok(ok.ok && ok.value.stop_reason === 'budget')

  const refusal = refused({
    code: 'downstream_refusal',
    attributableTo: 'tool',
    retryable: true,
    cause: causeOf('tool-fs', 'not_found', 'no such file'),
  })
  const checked = validateOutcome(refusal)
  assert.ok(checked.ok)
  assert.equal(checked.value.cause.code, 'not_found')

  assert.equal(validateOutcome(cancelled()).ok, true)
  const interruptedOutcome = validateOutcome(interrupted())
  assert.ok(interruptedOutcome.ok && interruptedOutcome.value.retryable === true)

  const unknownCode = validateOutcome({ kind: 'refused', code: 'pre_unsat', attributableTo: 'graph', retryable: false })
  assert.equal(unknownCode.ok, false)
  assert.equal(unknownCode.outcome.code, 'invalid_contract')

  const badAttribution = validateOutcome({ kind: 'refused', code: 'no_plan', attributableTo: 'user', retryable: false })
  assert.equal(badAttribution.ok, false)

  const committedWithCode = validateOutcome({ kind: 'committed', code: 'no_plan', retryable: false })
  assert.equal(committedWithCode.ok, false)
})

test('cause 原样透传下游码', () => {
  const cause = causeFromError('tool-fs', { ok: false, error: { code: 'not_found', message: 'gone' } })
  assert.deepEqual(cause, { from: 'tool-fs', code: 'not_found', message: 'gone' })
  assert.deepEqual(causeFromError('model-protocol', { code: 'model_timeout' }), {
    from: 'model-protocol',
    code: 'model_timeout',
  })
  assert.equal(causeFromError('x', { ok: false }), null)
})

test('validateBag：必需键、类型、版本与严格模式', () => {
  const minimal = {
    input: { content: 'hi' },
    input_body: {},
    config: {},
    session: {},
    thread: '_main',
    thread_kind: 'main',
  }
  assert.equal(validateBag(minimal).ok, true)
  assert.equal(validateBag({}).ok, false)
  assert.equal(validateBag({ ...minimal, thread: 7 }).ok, false)
  assert.equal(validateBag({ ...minimal, tools: {} }).ok, false)
  assert.equal(validateBag({ ...minimal, contract_version: '2.0' }).ok, false)
  assert.equal(validateBag({ ...minimal, contract_version: '1.1' }).ok, true)
  assert.equal(validateBag({ ...minimal, cursor: {} }, { strict: true }).ok, false)
  assert.equal(validateBag({ ...minimal, cursor: {} }).ok, true)
  assert.ok(INTERPRET_BAG_KEYS.includes('new_conversation') && INTERPRET_BAG_KEYS.includes('resume'))
})

test('validateStepRecord：五种记录', () => {
  const records = [
    {
      type: 'turn.open',
      turn_id: 't-1',
      conv: 'c-1',
      user_message: { content: 'hi' },
      slot_ref: 'run-1',
      at: '2026-09-28T00:00:00.000Z',
    },
    { type: 'step.intent', turn_id: 't-1', seq: 1, kind: 'tool.dispatch', tool_calls: [] },
    { type: 'step.result', turn_id: 't-1', seq: 1, assistant: { content: '' } },
    { type: 'checkpoint', turn_id: 't-1', seq: 1, summary: { goal: 'g' }, covered_upto: '1' },
    { type: 'turn.settle', turn_id: 't-1', outcome: { kind: 'committed', code: null, attributableTo: null, retryable: false, cause: null } },
  ]
  for (const record of records) assert.equal(validateStepRecord(record).ok, true)
  assert.equal(validateStepRecord({ type: 'nope', turn_id: 't' }).ok, false)
  assert.equal(validateStepRecord({ type: 'step.intent', turn_id: 't', seq: 1 }).ok, false)
  assert.equal(validateStepRecord({ type: 'turn.settle', turn_id: 't', outcome: { kind: 'bogus', retryable: false } }).ok, false)
})

test('retrieval.search bag：权威键与预算约束', () => {
  const bag = {
    query: 'q',
    workspace: 'w-1',
    recall_budget: 8,
    dedup_set: ['a'],
    model_config: {},
  }
  assert.equal(validateRetrievalSearchBag(bag).ok, true)
  assert.equal(validateRetrievalSearchBag({ ...bag, recall_budget: 0 }).ok, false)
  assert.equal(validateRetrievalSearchBag({ ...bag, workspace: 3 }).ok, false)
  assert.ok(RETRIEVAL_SEARCH_KEYS.includes('workspace'))
  assert.ok(!RETRIEVAL_SEARCH_KEYS.includes('workspace_id'))
})

test('推理块校验', () => {
  const block = { provider: 'anthropic', model: 'claude-sonnet-4-6', form: 'blocks', payload: [], signature: 's' }
  assert.equal(validateReasoningBlock(block).ok, true)
  assert.equal(validateReasoningBlock({ ...block, form: 'raw' }).ok, false)
  assert.equal(validateReasoningBlock({ provider: 'x', model: 'y', form: 'text' }).ok, false)
})

test('运行真源自包含：无 import、无 node: 依赖', () => {
  const source = readFileSync(RUNTIME_URL, 'utf8')
  assert.doesNotMatch(source, /^\s*import\s/m)
  assert.doesNotMatch(source, /['"`]node:/)
  assert.doesNotMatch(source, /\bprocess\./)
})
