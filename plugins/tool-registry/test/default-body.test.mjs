// 默认绑定表（数据世代 body）包形状测试：默认绑定表为空且合法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel) {
  return JSON.parse(readFileSync(join(PKG_ROOT, rel), 'utf8'))
}

test('tool-registry/default-body.json：绑定表为空且形状合法', () => {
  const body = readJson('tools/default-body.json')
  assert.equal(body.version, 1)
  assert.deepEqual(body.bindings, {})
})

test('默认绑定表只含 version / bindings，不夹带服务私有参数', () => {
  const body = readJson('tools/default-body.json')
  assert.deepEqual(Object.keys(body).sort(), ['bindings', 'version'])
})
