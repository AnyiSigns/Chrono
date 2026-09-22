// 浏览器侧入站客户端测试（node --test）：用假 `fetch` 驱动 `client.js`，覆盖
// 读-改-写只覆盖本线程键、读失败不整值覆盖、以及发送触发的命令形状。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readConfig, triggerSend, writeSlot } from '../execute/web/client.js'

/** 以假 `fetch` 记录请求并按 URL 回包；用完必须 `restore()`。 */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const body = init !== undefined && typeof init.body === 'string' ? JSON.parse(init.body) : null
    const target = String(url)
    calls.push({ url: target, body })
    const result = handler(target, body)
    const status = result.status ?? 200
    return { status, ok: status < 400, json: async () => result.json }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = original
    },
  }
}

test('写槽：先 input.read 再只覆盖本线程键的 put + add_gen', async () => {
  const stub = stubFetch((url) =>
    url.includes('api/command')
      ? { json: { ok: true, value: { slots: { _main: { kind: 'idle' }, t1: { kind: 'idle' } } } } }
      : { status: 202, json: { ok: true, run: 'run-1' } },
  )
  try {
    const result = await writeSlot('t1', {
      kind: 'chat.message',
      text: 'hi',
      attachments: [],
    })
    assert.equal(result.ok, true)
    assert.equal(stub.calls.length, 2)

    assert.ok(stub.calls[0].url.includes('api/command'))
    assert.equal(stub.calls[0].body.name, 'input.read')
    assert.equal(stub.calls[0].body.thread, 't1')

    assert.ok(stub.calls[1].url.includes('api/submit'))
    assert.equal(stub.calls[1].body.thread, 't1')
    const ops = stub.calls[1].body.directives[0].request.args.ops
    assert.deepEqual(Object.keys(ops[0].args.body.slots).sort(), ['_main', 't1'])
    assert.equal(ops[0].args.body.slots.t1.text, 'hi')
    assert.deepEqual(ops[0].args.body.slots._main, { kind: 'idle' })
    assert.deepEqual(ops[1].args, {
      id: 'input',
      payload: { $n: 0 },
      sig: { $n: 0 },
      pins: {},
    })
  } finally {
    stub.restore()
  }
})

test('写槽：input.read 读不到整份 body 时不提交（不整值覆盖其它线程）', async () => {
  const stub = stubFetch((url) =>
    url.includes('api/command')
      ? { json: { ok: true, value: null } }
      : { status: 202, json: { ok: true, run: 'run-1' } },
  )
  try {
    const result = await writeSlot('t1', { kind: 'chat.message', text: 'hi', attachments: [] })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'input_unavailable')
    assert.equal(stub.calls.length, 1)
  } finally {
    stub.restore()
  }
})

test('触发发送：按名调无参 chat.send，信封带线程', async () => {
  const stub = stubFetch(() => ({ json: { ok: true, value: null } }))
  try {
    await triggerSend('t1')
    assert.equal(stub.calls.length, 1)
    assert.ok(stub.calls[0].url.includes('api/command'))
    assert.equal(stub.calls[0].body.name, 'chat.send')
    assert.equal(stub.calls[0].body.args, null)
    assert.equal(stub.calls[0].body.thread, 't1')
  } finally {
    stub.restore()
  }
})

test('读配置：命令失败或回非对象时回 null', async () => {
  const failing = stubFetch(() => ({ status: 502, json: { ok: false, code: 'ui_unreachable' } }))
  try {
    assert.equal(await readConfig(), null)
  } finally {
    failing.restore()
  }
  const wrongShape = stubFetch(() => ({ json: { ok: true, value: 'nope' } }))
  try {
    assert.equal(await readConfig(), null)
  } finally {
    wrongShape.restore()
  }
})
