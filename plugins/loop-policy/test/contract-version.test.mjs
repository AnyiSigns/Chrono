// 契约版本边界：bag 带 contract_version 且主版本不匹配 ⇒ 立即拒绝并给契约的结构化结局；
// 缺失视为未标注版本（兼容接受），并在摘要里记下该事实；主版本一致（含更高小版本）照常执行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'

function summaryOf(value) {
  for (const directive of value?.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload && directive.payload.kind === 'interpret') return directive.payload
  }
  return null
}

function settlesOf(service) {
  return service.portCalls.filter((call) => call.port === 'session' && call.method === 'turn_settle').map((call) => call.args)
}

test('未知主版本：立即拒绝，结局为契约的 contract_version_mismatch（owner），不派发模型', async () => {
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', contract_version: '2.0' })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'refused')
    assert.equal(summary.outcome.kind, 'refused')
    assert.equal(summary.outcome.code, 'contract_version_mismatch')
    assert.equal(summary.outcome.attributableTo, 'owner')
    assert.match(summary.outcome.message, /unsupported contract_version: 2\.0/)
    assert.equal(settlesOf(service).at(-1).outcome.code, 'contract_version_mismatch')
    assert.equal(
      service.portCalls.some((call) => call.port === 'model' && call.method === 'chat'),
      false,
      '未知主版本不得派发模型调用',
    )
  } finally {
    service.close()
  }
})

test('缺失版本：接受为未标注版本，摘要合同版本为 null，照常收口 committed', async () => {
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1' })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.equal(summary.contract_version, null)
    assert.equal(summary.outcome.kind, 'committed')
    assert.equal(settlesOf(service).at(-1).outcome.kind, 'committed')
  } finally {
    service.close()
  }
})

test('兼容版本：主版本一致（含更高小版本）照常执行并记下标注值', async () => {
  const service = startService()
  try {
    const result = await service.interpret({ turn_id: 't1', contract_version: '1.7' })
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done', JSON.stringify(summary))
    assert.equal(summary.contract_version, '1.7')
    assert.equal(summary.outcome.kind, 'committed')
  } finally {
    service.close()
  }
})
