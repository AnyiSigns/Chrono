// 本插件 schema 顶层 `periodic` 的声明自检：方法名必须是裸方法名（不含能力类前缀），
// 且周期为正。宿主按裸方法名匹配周期条目；宿主如何解析该声明属跨层行为，落根 `tests/contract/`。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('schema periodic：声明为裸方法名 sync 且周期为正', () => {
  const schema = JSON.parse(readFileSync(join(PKG_ROOT, 'schema', 'protocol.json'), 'utf8'))
  const periodic = schema.periodic
  assert.ok(Array.isArray(periodic), 'periodic 必须是数组')
  assert.equal(periodic.length, 1)
  const entry = periodic[0]
  assert.equal(entry.method, 'sync')
  assert.equal(entry.method.includes('.'), false, 'periodic.method 必须是裸方法名')
  assert.equal(typeof entry.every_ms === 'number' && entry.every_ms > 0, true)
})
