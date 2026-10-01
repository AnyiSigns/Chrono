// 解释器侧保留的结构辅助单测：规则表达式解析、待办状态与 tool_calls 结构检查。
// 判据求值本身已归拥有方 loop-policy（经 `loop-rule` 能力按名求值），此处不再枚举判据名。
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkToolCalls, parseRule, todoIncomplete } from '../execute/rules.ts'

test('parseRule：name 与 name(args) 两种形状', () => {
  assert.deepEqual(parseRule('nonempty(tool_calls)'), { name: 'nonempty', args: 'tool_calls' })
  assert.deepEqual(parseRule('always'), { name: 'always', args: '' })
  assert.deepEqual(parseRule('eq(verdict:allow)'), { name: 'eq', args: 'verdict:allow' })
})

test('todo_incomplete：pending / in_progress 为真', () => {
  assert.equal(todoIncomplete({ items: [{ status: 'pending' }] }), true)
  assert.equal(todoIncomplete({ items: [{ status: 'done' }] }), false)
  assert.equal(todoIncomplete([{ status: 'in_progress' }]), true)
  assert.equal(todoIncomplete(undefined), false)
  assert.equal(todoIncomplete({ conversations: { c1: { items: [{ status: 'pending' }] } } }), true)
})

test('checkToolCalls：接受模型原始形状与归一形状', () => {
  const raw = checkToolCalls([{ id: 'c1', name: 'edit', arguments: '{"path":"a"}' }])
  assert.equal(raw.ok, true)
  assert.deepEqual(raw.calls[0].args, { path: 'a' })
  const normalized = checkToolCalls([{ call_id: 'c1', tool: 'edit', args: { path: 'a' } }])
  assert.equal(normalized.ok, true)
  assert.equal(checkToolCalls([{ id: 'c', name: '', args: {} }]).ok, false)
  assert.equal(checkToolCalls([{ id: 'c', name: 'a', args: 'nope' }]).ok, false)
  assert.equal(checkToolCalls([{ id: 'c', name: 'a', args: {} }, { id: 'c', name: 'b', args: {} }]).ok, false)
})
