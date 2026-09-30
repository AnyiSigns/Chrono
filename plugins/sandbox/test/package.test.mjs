import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(relative) {
  return JSON.parse(readFileSync(join(PKG_ROOT, relative), 'utf8'))
}

test('plugin.json 保留受保护身份与公开方法，委派三提供方', () => {
  const plugin = readJson('plugin.json')
  assert.equal(plugin.identity, 'sandbox')
  assert.deepEqual(plugin.implements, ['sandbox'])
  assert.deepEqual(plugin.methods['sandbox'], [
    'exec',
    'exec_start',
    'exec_poll',
    'exec_kill',
    'session_close',
    'fsop',
    'capabilities',
  ])
  assert.ok('pins' in plugin, 'pins 必填')
  assert.deepEqual(plugin.needs['sandbox-policy'], { mode: 'one' })
  assert.deepEqual(plugin.needs['sandbox-exec'], { mode: 'one' })
  assert.deepEqual(plugin.needs['sandbox-fs'], { mode: 'one' })
  assert.deepEqual(plugin.commands, [])
})

test('schema 方法级超时严格嵌套（门面 > 提供方 + 判定）', () => {
  const schema = readJson('schema/sandbox.json')
  const exec = readJson(join('..', 'sandbox-exec', 'schema', 'sandbox-exec.json'))
  const fs = readJson(join('..', 'sandbox-fs', 'schema', 'sandbox-fs.json'))
  const policy = readJson(join('..', 'sandbox-policy', 'schema', 'sandbox-policy.json'))
  assert.ok(
    schema.method_timeouts['sandbox.exec'] >
      policy.method_timeouts['sandbox-policy.resolve'] + exec.method_timeouts['sandbox-exec.exec'],
    'sandbox.exec 上界须大于判定 + 执行之和',
  )
  assert.ok(
    schema.method_timeouts['sandbox.fsop'] >
      policy.method_timeouts['sandbox-policy.resolve'] + fs.method_timeouts['sandbox-fs.fsop'],
    'sandbox.fsop 上界须大于判定 + 执行之和',
  )
})

test('无 terms/ 目录', () => {
  assert.equal(existsSync(join(PKG_ROOT, 'terms')), false, '不应有 terms/')
})
