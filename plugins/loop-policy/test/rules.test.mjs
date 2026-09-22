// 种子判定 / pre / post / 结构检查的单元测试（纯函数，不起服务）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkToolCalls, evalPost, evalPre, evalWhen, todoIncomplete, wroteFiles } from '../execute/rules.ts'

function ctx(outputs, state = {}) {
  return { nodeIndex: 0, outputs: new Map(Object.entries(outputs).map(([k, v]) => [Number(k), v])), inputs: new Map(), shared: {}, thresholds: {}, effLog: [], state }
}

test('when：nonempty / empty / verdict_is / eq / not', () => {
  const c = ctx({ 1: { tool_calls: [{ name: 'edit' }], message: { role: 'assistant' } }, 2: { verdict: 'allow' }, 3: { decision: 'approved' } })
  assert.equal(evalWhen('nonempty(tool_calls)', c, 1), true)
  assert.equal(evalWhen('empty(message)', c, 1), false)
  assert.equal(evalWhen('empty(tool_calls)', c, 1), false)
  assert.equal(evalWhen('verdict_is(allow)', c, 2), true)
  assert.equal(evalWhen('verdict_is(deny)', c, 2), false)
  assert.equal(evalWhen('verdict_is(approved)', c, 3), true)
  assert.equal(evalWhen('eq(verdict:allow)', c, 2), true)
  assert.equal(evalWhen('not verdict_is(deny)', c, 2), true)
  assert.equal(evalWhen('', c, 1), true, '缺省无条件')
})

test('when：wrote_files 按写类工具成功项判定', () => {
  const tools = [
    { name: 'edit', caps: { fs: { write: 'workspace' } } },
    { name: 'read', caps: { fs: { write: 'none' } } },
  ]
  const calls = [{ call_id: 'c1', tool: 'edit' }, { call_id: 'c2', tool: 'read' }]
  const results = [{ call_id: 'c1', ok: true, result: { path: 'a' } }, { call_id: 'c2', ok: true, result: {} }]
  assert.equal(wroteFiles(results, calls, tools), true)
  assert.equal(wroteFiles([{ call_id: 'c2', ok: true, result: {} }], calls, tools), false)
  assert.equal(wroteFiles([{ call_id: 'c1', ok: false, error: { code: 'x' } }], calls, tools), false)
})

test('todo_incomplete：pending / in_progress 为真', () => {
  assert.equal(todoIncomplete({ items: [{ status: 'pending' }] }), true)
  assert.equal(todoIncomplete({ items: [{ status: 'done' }] }), false)
  assert.equal(todoIncomplete([{ status: 'in_progress' }]), true)
  assert.equal(todoIncomplete(undefined), false)
})

test('step_post：非空 ∧ 恰有其一 ∧ tool_calls 结构合法', () => {
  const ok = { ok: true, text: 'hi', tool_calls: [] }
  assert.deepEqual(evalPost('step_post', ctx({ 0: ok })), { ok: true })
  assert.equal(evalPost('step_post', ctx({ 0: { ok: true, text: '', tool_calls: [] } })).reason, 'empty_output')
  assert.equal(evalPost('step_post', ctx({ 0: { ok: true, text: 'x', tool_calls: [{ name: 'a' }] } })).reason, 'message_and_tool_calls')
  assert.equal(evalPost('step_post', ctx({ 0: { ok: true, text: '', tool_calls: [{ id: 'c', name: '', args: {} }] } })).reason, 'malformed_tool_call')
  assert.equal(evalPost('step_post', ctx({ 0: { ok: true, text: '', tool_calls: [{ id: 'c', name: 'a', args: 'nope' }] } })).reason, 'malformed_tool_call')
  assert.equal(evalPost('step_post', ctx({ 0: { ok: true, text: '', tool_calls: [{ id: 'c', name: 'a', args: {} }, { id: 'c', name: 'b', args: {} }] } })).reason, 'malformed_tool_call')
})

test('assemble_post / dispatch_post / verify_post 结构检查', () => {
  assert.deepEqual(evalPost('assemble_post', ctx({ 0: { messages: [{ role: 'user' }], params: { model: 'm' } } })), { ok: true })
  assert.equal(evalPost('assemble_post', ctx({ 0: { messages: [], params: {} } })).reason, 'empty_messages')
  const dispatchCtx = ctx({ 0: { results: [{ call_id: 'c', ok: false, error: { code: 'x' } }] } })
  dispatchCtx.inputs.set(0, { calls: [{ call_id: 'c' }] })
  assert.deepEqual(evalPost('dispatch_post', dispatchCtx), { ok: true })
  assert.equal(evalPost('verify_post', ctx({ 0: { report: { skipped: true } } })).ok, true)
  assert.equal(evalPost('verify_post', ctx({ 0: { report: { passed: false } } })).reason, 'no_detail')
  assert.equal(evalPost('verify_post', ctx({ 0: {} })).reason, 'no_report')
})

test('pre：未知规则 fail-closed', () => {
  assert.equal(evalPre('always', ctx({})).ok, true)
  assert.equal(evalPre('nope', ctx({})).code, 'pre_unsat')
})

test('checkToolCalls：接受模型原始形状与归一形状', () => {
  const raw = checkToolCalls([{ id: 'c1', name: 'edit', arguments: '{"path":"a"}' }])
  assert.equal(raw.ok, true)
  assert.deepEqual(raw.calls[0].args, { path: 'a' })
  const normalized = checkToolCalls([{ call_id: 'c1', tool: 'edit', args: { path: 'a' } }])
  assert.equal(normalized.ok, true)
})
