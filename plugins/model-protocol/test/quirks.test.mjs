// quirks 原语测试：点路径写入与原型键防护。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setByPath } from '../execute/quirks.ts'

test('setByPath：正常点路径写入', () => {
  const target = {}
  setByPath(target, 'thinkingConfig.thinkingBudget', 128)
  assert.deepEqual(target, { thinkingConfig: { thinkingBudget: 128 } })
})

test('setByPath：原型键段整体放弃，不污染原型 / 不覆写构造器', () => {
  const target = {}
  setByPath(target, '__proto__.polluted', true)
  setByPath(target, 'constructor.prototype.polluted', true)
  assert.equal({}.polluted, undefined)
  assert.deepEqual(target, {})
})
