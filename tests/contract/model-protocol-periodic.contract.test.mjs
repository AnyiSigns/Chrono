// 接缝契约：模型插件的 schema `periodic` 声明必须能被真实宿主声明读取器解析。
// 宿主的周期读取按裸方法名匹配；若插件把方法名写成 `model.sync`，宿主会静默 refused 且不记
// `periodic_invalid`。该断言跨插件与宿主两层，故住根 tests/contract/，import 真实宿主函数。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readPeriodicEntries } from '../../packages/host/periodic.ts'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

test('model-protocol schema periodic：真实宿主读取器按裸方法名解析 sync', () => {
  const schema = JSON.parse(
    readFileSync(join(ROOT, 'plugins', 'model-protocol', 'schema', 'protocol.json'), 'utf8'),
  )
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
