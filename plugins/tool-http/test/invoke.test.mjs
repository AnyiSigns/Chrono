// invoke 路由测试：未知工具统一为 unknown_tool；顶层兜底把异常转结构化错误。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { invoke } from '../execute/methods.ts'

test('未知工具 → unknown_tool（与 tool-shell 统一）', async () => {
  const result = await invoke({ tool: 'nope', args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'unknown_tool')
})

test('缺 tool → bad_args', async () => {
  const result = await invoke({ args: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad_args')
})
