// `tool-schema` 协议级测试（node --test）：三方法经 stdio 协议可调、形态与纯函数面一致、坏 args 回结构化码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService } from 'plugin-sdk'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')

function driver() {
  return startService({ entry: ENTRY, cwd: PKG_ROOT, timeoutMs: 15000 })
}

async function callValue(drv, method, args) {
  const message = await drv.call('tool-schema', method, args)
  assert.equal(message.kind, 'result', JSON.stringify(message))
  return message.value
}

test('hello 回 manifest：三方法声明与 plugin.json 一致', async () => {
  const drv = driver()
  try {
    const manifest = await drv.hello('tool-schema')
    assert.equal(manifest.identity, 'tool-schema')
    assert.deepEqual(manifest.implements, ['tool-schema'])
    assert.deepEqual(manifest.methods['tool-schema'], [
      'normalize-decl',
      'validate-args',
      'normalize-caps',
    ])
  } finally {
    drv.close()
    await drv.exit
  }
})

test('normalize-decl：严格校验白名单、宽松净化白名单外关键词', async () => {
  const drv = driver()
  try {
    await drv.hello('tool-schema')
    const strictOk = await callValue(drv, 'normalize-decl', {
      schema: { type: 'object', properties: { path: { type: 'string' } } },
    })
    assert.equal(strictOk.ok, true)

    const strictBad = await callValue(drv, 'normalize-decl', {
      schema: { type: 'object', properties: { path: { type: 'string', pattern: '^x' } } },
    })
    assert.equal(strictBad.ok, false)
    assert.match(strictBad.message, /pattern/)
    assert.equal(strictBad.schema, null)

    const lenient = await callValue(drv, 'normalize-decl', {
      schema: { type: 'object', $schema: 'x', properties: { q: { type: 'string', pattern: 'x' } } },
      lenient: true,
    })
    assert.equal(lenient.ok, true)
    assert.equal(lenient.schema.$schema, undefined)
    assert.equal(lenient.schema.properties.q.pattern, undefined)
  } finally {
    drv.close()
    await drv.exit
  }
})

test('validate-args：required / enum / additionalProperties / 码点长度', async () => {
  const drv = driver()
  try {
    await drv.hello('tool-schema')
    const schema = {
      type: 'object',
      properties: { path: { type: 'string', minLength: 2 }, mode: { enum: ['a', 'b'] } },
      required: ['path'],
      additionalProperties: false,
    }
    assert.equal(
      (await callValue(drv, 'validate-args', { schema, value: { path: 'ab' } })).ok,
      true,
    )
    assert.equal((await callValue(drv, 'validate-args', { schema, value: {} })).ok, false)
    assert.equal(
      (await callValue(drv, 'validate-args', { schema, value: { path: 'ab', mode: 'c' } })).ok,
      false,
    )
    assert.equal(
      (await callValue(drv, 'validate-args', { schema, value: { path: 'ab', extra: 1 } })).ok,
      false,
    )
  } finally {
    drv.close()
    await drv.exit
  }
})

test('normalize-caps：对象形 / 布尔 net / 数值上限', async () => {
  const drv = driver()
  try {
    await drv.hello('tool-schema')
    const ok = await callValue(drv, 'normalize-caps', {
      caps: { fs: { read: 'workspace', write: 'none' }, net: false, timeout_ms: 1000 },
    })
    assert.equal(ok.ok, true)
    assert.equal(ok.caps.net, 'none')
    assert.equal(ok.caps.timeout_ms, 1000)
    assert.equal(
      (await callValue(drv, 'normalize-caps', { caps: { fs: { write: 'none' } } })).ok,
      false,
    )
    assert.equal((await callValue(drv, 'normalize-caps', { caps: null })).ok, false)
    assert.equal(
      (await callValue(drv, 'normalize-caps', { caps: null, lenient: true })).caps.net,
      'unset',
    )
  } finally {
    drv.close()
    await drv.exit
  }
})

test('坏 args：非对象 → bad_args；未知方法 → unknown_method', async () => {
  const drv = driver()
  try {
    await drv.hello('tool-schema')
    const bad = await drv.call('tool-schema', 'validate-args', [1, 2])
    assert.equal(bad.kind, 'error')
    assert.equal(bad.code, 'bad_args')
    const unknown = await drv.call('tool-schema', 'nope', {})
    assert.equal(unknown.kind, 'error')
    assert.equal(unknown.code, 'unknown_method')
    assert.equal(drv.portCalls.length, 0, 'tool-schema 不得发反向调用')
  } finally {
    drv.close()
    await drv.exit
  }
})
