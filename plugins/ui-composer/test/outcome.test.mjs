// `ui-composer` 结局读值测试（node --test）：命令回执 `ok:true` 但业务结局失败时，vm 必须呈现失败；
// 逐类注入 committed / refused / cancelled / interrupted，并覆盖回合前拒绝的引导分支。

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { displayCode, parseOutcome, parsePreTurnRefusal, receiptView } from '../execute/web/outcome.ts'

/** 壳回帧：外层恒 `{ok:true}`，业务成败只看 `value`。 */
function shellReceipt(value) {
  return { ok: true, value }
}

function outcome(extra) {
  return {
    kind: 'refused',
    code: null,
    attributableTo: null,
    retryable: false,
    cause: null,
    ...extra,
  }
}

test('I19：回执 ok:true + 结局 refused → vm 呈现失败（码 / 归因）', () => {
  const vm = receiptView(
    shellReceipt({
      ok: false,
      outcome: outcome({ kind: 'refused', code: 'loop_unavailable', attributableTo: 'transport', retryable: true }),
      turn_id: 't-1',
      thread: 'c1',
      conversation: 'c1',
    }),
  )
  assert.equal(vm.kind, 'failure')
  assert.equal(vm.displayCode, 'loop_unavailable')
  assert.equal(vm.attributableTo, 'transport')
  assert.equal(vm.retryable, true)
})

test('I19：逐类注入结局，vm 分支正确', () => {
  const committed = receiptView(
    shellReceipt({ kind: 'interpret', settled: true, outcome: outcome({ kind: 'committed', retryable: false }) }),
  )
  assert.equal(committed.kind, 'success')
  assert.equal(committed.displayCode, null)

  const refused = receiptView(shellReceipt({ outcome: outcome({ kind: 'refused', code: 'downstream_refusal', attributableTo: 'graph' }) }))
  assert.equal(refused.kind, 'failure')
  assert.equal(refused.attributableTo, 'graph')

  const cancelled = receiptView(shellReceipt({ outcome: outcome({ kind: 'cancelled', code: 'cancelled', attributableTo: 'owner' }) }))
  assert.equal(cancelled.kind, 'failure')
  assert.equal(cancelled.displayCode, 'cancelled')

  const interrupted = receiptView(shellReceipt({ outcome: outcome({ kind: 'interrupted', code: 'interrupted', attributableTo: 'owner', retryable: true }) }))
  assert.equal(interrupted.kind, 'failure')
  assert.equal(interrupted.displayCode, 'interrupted')
  assert.equal(interrupted.retryable, true)
})

test('展示码回落到下游 cause.code（不改名）', () => {
  const vm = receiptView(
    shellReceipt({
      outcome: outcome({ kind: 'refused', code: null, attributableTo: 'tool', cause: { from: 'tool-fs', code: 'not_found', message: 'x' } }),
    }),
  )
  assert.equal(vm.kind, 'failure')
  assert.equal(vm.displayCode, 'not_found')
  assert.equal(displayCode(parseOutcome({ outcome: outcome({ code: null, cause: { from: 'x', code: 'boom' } }) })), 'boom')
})

test('回合前拒绝 → 引导分支（不落结局、不持久化）', () => {
  const model = receiptView(shellReceipt({ ok: false, error: { code: 'model_not_configured', message: 'no model' } }))
  assert.equal(model.kind, 'guidance')
  assert.equal(model.action, 'settings')
  assert.equal(model.displayCode, 'model_not_configured')

  const workspace = receiptView(shellReceipt({ ok: false, error: { code: 'workspace_missing', message: 'no workspace' } }))
  assert.equal(workspace.kind, 'guidance')
  assert.equal(workspace.action, null)

  const empty = receiptView(shellReceipt({ ok: false, error: { code: 'empty_slot', message: 'empty' } }))
  assert.equal(empty.kind, 'guidance')
})

test('无可呈现内容：非终态计划 / transport_failed / 空值 → none', () => {
  assert.equal(receiptView(shellReceipt({ $directives: [{ kind: 'eval', command: 'chat.resume' }] })).kind, 'none')
  assert.equal(receiptView(shellReceipt(null)).kind, 'none')
  assert.equal(receiptView(null).kind, 'none')
  assert.equal(receiptView(undefined).kind, 'none')
})

test('parsePreTurnRefusal：有结局时不误判为回合前拒绝', () => {
  assert.equal(parsePreTurnRefusal({ ok: false, outcome: outcome({}), error: { code: 'x' } }), null)
  assert.deepEqual(parsePreTurnRefusal({ ok: false, error: { code: 'empty_slot', message: 'm' } }), {
    code: 'empty_slot',
    message: 'm',
  })
  assert.equal(parsePreTurnRefusal({ ok: true }), null)
})
