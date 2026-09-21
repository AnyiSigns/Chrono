// 宿主级断言：本插件 schema 顶层 `periodic` 的方法名必须是裸方法名（宿主按裸方法名匹配），
// 否则宿主静默 refused 且不记 `periodic_invalid`。这里直接喂宿主的声明读取器验证可解析。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readPeriodicEntries } from '../../../packages/host/periodic.ts'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('schema periodic：宿主按裸方法名解析，声明的 sync 不再是 model.sync', () => {
  const schema = JSON.parse(readFileSync(join(PKG_ROOT, 'schema', 'protocol.json'), 'utf8'))
  const world = {
    defs: { s1: { body: schema } },
    ids: {
      'model-protocol': {
        id: 'model-protocol',
        schema: 's1',
        gens: [{ seq: 0, payload: 's1' }],
        active: 's1',
        born: { at: 0, by: 'test' },
      },
    },
  }
  const { entries, invalid } = readPeriodicEntries(world)
  assert.deepEqual(invalid, [])
  assert.equal(entries.length, 1)
  assert.equal(entries[0].method, 'sync')
  assert.equal(entries[0].everyMs > 0, true)
})
