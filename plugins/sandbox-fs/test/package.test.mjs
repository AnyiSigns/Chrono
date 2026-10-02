import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relative) {
  return JSON.parse(readFileSync(join(PKG_ROOT, relative), 'utf8'))
}

test('plugin.json 声明身份 / 方法 / needs / schema', () => {
  const plugin = readJson('plugin.json')
  assert.equal(plugin.identity, 'sandbox-fs')
  assert.deepEqual(plugin.implements, ['sandbox-fs'])
  assert.deepEqual(plugin.methods['sandbox-fs'], ['fsop', 'capabilities'])
  assert.ok(!('pins' in plugin), 'pins 字段已删除')
  assert.deepEqual(plugin.needs['sandbox-policy'], { mode: 'one' })
  assert.deepEqual(plugin.commands, [])
})

test('schema 声明 method_timeouts / audit_redact', () => {
  const schema = readJson('schema/sandbox-fs.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.method_timeouts['sandbox-fs.fsop'], 60000)
  assert.deepEqual(schema.audit_redact['sandbox-fs.fsop'], [])
})

test('无 terms/ 目录', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
})
