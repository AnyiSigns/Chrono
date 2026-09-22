// 声明级断言：本插件 schema 顶层 `periodic` 的 sweep 方法名必须是裸方法名（宿主按裸方法名匹配），
// 且 reads 路径可解析；`.worldignore` 不入世界由 E2E 覆盖。这里用测试内联的最小声明读取器
// （与宿主 readPeriodicEntries 同口径，测试不得 import 宿主包）验证可解析。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 最小周期声明读取器（宿主 readPeriodicEntries 的测试内联子集）。 */
function readPeriodicEntries(world) {
  const entries = []
  const invalid = []
  for (const identity of Object.keys(world.ids).sort()) {
    const record = world.ids[identity]
    if (record.active === null) continue
    const body = world.defs[record.schema]?.body
    if (body === null || typeof body !== 'object' || Array.isArray(body)) continue
    const periodic = body.periodic
    if (periodic === undefined) continue
    if (!Array.isArray(periodic)) {
      invalid.push({ identity, reason: 'bad_periodic' })
      continue
    }
    for (const raw of periodic) {
      const command =
        typeof raw.command === 'string' && raw.command.length > 0 ? raw.command : undefined
      const method = typeof raw.method === 'string' && raw.method.length > 0 ? raw.method : undefined
      if ((command === undefined) === (method === undefined)) {
        invalid.push({ identity, reason: 'bad_target' })
        continue
      }
      const everyMs = raw.every_ms
      if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs <= 0) {
        invalid.push({ identity, reason: 'bad_every_ms' })
        continue
      }
      const reads = []
      for (const [key, path] of Object.entries(raw.reads ?? {})) reads.push({ key, path })
      const entry = { identity, everyMs, reads }
      if (command !== undefined) entry.command = command
      else entry.method = method
      entries.push(entry)
    }
  }
  return { entries, invalid }
}

function schemaWorld(schema) {
  return {
    defs: { s1: { body: schema } },
    ids: {
      approval: {
        id: 'approval',
        schema: 's1',
        gens: [{ seq: 0, payload: 's1' }],
        active: 's1',
        born: { at: 0, by: 'test' },
      },
    },
  }
}

test('schema periodic：sweep 按裸方法名解析，reads 指向 approval body/refs', () => {
  const schema = JSON.parse(readFileSync(join(PKG_ROOT, 'schema', 'approval.json'), 'utf8'))
  const { entries, invalid } = readPeriodicEntries(schemaWorld(schema))
  assert.deepEqual(invalid, [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].method, 'sweep')
  assert.equal(entries[0].command, undefined)
  assert.equal(entries[0].everyMs > 0, true)
  const byKey = Object.fromEntries(entries[0].reads.map((read) => [read.key, read.path]))
  assert.deepEqual(byKey.queue, ['ids', 'approval', 'body'])
  assert.deepEqual(byKey.refs, ['ids', 'approval', 'refs'])
})

test('schema：默认超时 10 分钟、容量与裁决策略就位', () => {
  const schema = JSON.parse(readFileSync(join(PKG_ROOT, 'schema', 'approval.json'), 'utf8'))
  assert.equal(schema.timeout_ms, 600000)
  assert.equal(typeof schema.capacity, 'number')
  assert.equal(schema.policy.capacity_scope, 'pending')
})
