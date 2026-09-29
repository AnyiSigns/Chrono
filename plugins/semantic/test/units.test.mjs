// `semantic` 逻辑级测试（node --test）：直接 import execute 源码。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BackendError, RemoteModel } from '../execute/port-link.ts'
import { semanticSummary } from '../execute/semantic.ts'

/** 记录反向调用并同步应答的假通道。 */
function fakeLink(responder) {
  const calls = []
  return {
    calls,
    call: async (port, method, args, options) => {
      calls.push({ port, method, args, options })
      return responder(port, method, args)
    },
  }
}

test('semanticSummary：模型出 JSON 即用；围栏解析', async () => {
  const model = {
    chat: async () => ({ ok: true, text: '```json\n{"goal":"m","facts":["f1","f2"]}\n```' }),
  }
  const ok = await semanticSummary({ model_config: { base_url: 'x' } }, {}, model)
  assert.equal(ok.summary.goal, 'm')
  assert.deepEqual(ok.summary.facts, ['f1', 'f2'])
})

test('semanticSummary：缺 config / 空文本 / 解析失败 / 模型异常回结构化错误', async () => {
  const model = { chat: async () => ({ ok: true, text: '{"goal":"x"}' }) }
  const missing = await semanticSummary({}, {}, model)
  assert.equal(missing.error.code, 'model_config_required')

  const empty = await semanticSummary(
    { model_config: {} },
    {},
    { chat: async () => ({ ok: true }) },
  )
  assert.equal(empty.error.code, 'semantic_empty')

  const bad = await semanticSummary(
    { model_config: {} },
    {},
    { chat: async () => ({ ok: true, text: 'nope' }) },
  )
  assert.equal(bad.error.code, 'semantic_parse_failed')

  const boom = await semanticSummary(
    { model_config: {} },
    {},
    {
      chat: async () => {
        throw new Error('boom')
      },
    },
  )
  assert.equal(boom.error.code, 'model_call_failed')

  const backend = await semanticSummary(
    { model_config: {} },
    {},
    {
      chat: async () => {
        throw new BackendError('model_server_error', 'down')
      },
    },
  )
  assert.equal(backend.error.code, 'model_server_error')
})

test('semanticSummary：existing_l1 与 session_slice 进 user 消息', async () => {
  let seen = null
  const model = {
    chat: async (_config, messages) => {
      seen = messages
      return { ok: true, text: '{"goal":"x"}' }
    },
  }
  await semanticSummary(
    { model_config: { base_url: 'x' }, session_slice: [{ role: 'user', content: 'hi' }] },
    { goal: 'prior', facts: ['f'] },
    model,
  )
  const body = JSON.parse(seen[1].content)
  assert.equal(body.existing_l1.goal, 'prior')
  assert.deepEqual(body.session_slice, [{ role: 'user', content: 'hi' }])
})

test('RemoteModel：经反向 port.call 调 model.chat，带 model.chat 声明超时', async () => {
  const link = fakeLink(() => ({ ok: true, value: { ok: true, text: 'x' } }))
  const model = new RemoteModel(link)
  const value = await model.chat({ base_url: 'x' }, [{ role: 'user', content: 'hi' }])
  assert.equal(value.text, 'x')
  assert.equal(link.calls.length, 1)
  assert.equal(link.calls[0].port, 'model')
  assert.equal(link.calls[0].method, 'chat')
  assert.ok(link.calls[0].options.timeoutMs >= 3600000)
})

test('RemoteModel：port 失败 / 回包 ok:false → 结构化 BackendError', async () => {
  const failed = new RemoteModel(
    fakeLink(() => ({ ok: false, code: 'transport_failed', message: 'x' })),
  )
  await assert.rejects(
    failed.chat({}, []),
    (err) => err instanceof BackendError && err.code === 'transport_failed',
  )
  const reported = new RemoteModel(
    fakeLink(() => ({ ok: true, value: { ok: false, error: { code: 'model_server_error' } } })),
  )
  await assert.rejects(
    reported.chat({}, []),
    (err) => err instanceof BackendError && err.code === 'model_server_error',
  )
})
