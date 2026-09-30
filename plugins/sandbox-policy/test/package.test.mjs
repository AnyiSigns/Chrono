import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relative) {
  return JSON.parse(readFileSync(join(PKG_ROOT, relative), 'utf8'))
}

test('plugin.json 声明身份 / 方法 / schema', () => {
  const plugin = readJson('plugin.json')
  assert.equal(plugin.identity, 'sandbox-policy')
  assert.deepEqual(plugin.implements, ['sandbox-policy'])
  assert.deepEqual(plugin.methods['sandbox-policy'], ['resolve', 'consume'])
  assert.ok('pins' in plugin, 'pins 必填')
  assert.equal(plugin.state, 'recomputable')
  assert.deepEqual(plugin.commands, [])
})

test('schema 声明 method_timeouts / audit_redact', () => {
  const schema = readJson('schema/sandbox-policy.json')
  assert.equal(schema.type, 'object')
  assert.equal(schema.method_timeouts['sandbox-policy.resolve'], 5000)
  assert.deepEqual(schema.audit_redact['sandbox-policy.resolve'], [])
  assert.deepEqual(schema.audit_redact['sandbox-policy.consume'], ['grant'])
})

test('无 terms/ 目录且无命令面', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
})
