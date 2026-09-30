// 默认绑定表（数据世代 body）包形状测试：随记忆 / 压缩插件删除，默认绑定表为空且合法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from './driver.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readJson(rel) {
  return JSON.parse(readFileSync(join(PKG_ROOT, rel), 'utf8'))
}

test('tools/default-body.json：绑定表为空且形状合法', () => {
  const body = readJson('tools/default-body.json')
  assert.equal(body.version, 1)
  assert.deepEqual(body.bindings, {})
})

test('默认绑定表进目录：list 无拒绝，无绑定工具', async () => {
  const body = readJson('tools/default-body.json')
  const service = startService()
  try {
    await service.hello()
    const listed = await service.call('list', { tools_bindings: body })
    assert.equal(listed.kind, 'result', JSON.stringify(listed))
    assert.deepEqual(listed.value.rejected, [], JSON.stringify(listed.value.rejected))
    assert.deepEqual(listed.value.tools, [])
  } finally {
    service.close()
  }
})
