// 纯函数级测试：schema 配置装载 + 后端抽象（零依赖，node --test）。
// 标题后处理原语（去引号标点 / 码点截断 / 兜底顺序）已迁至 `title-format` 提供方，其行为住该插件测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HARD_MAX_CHARS, loadBaseConfig, resolveConfig } from '../execute/config.ts'
import { PortLink } from 'plugin-sdk'
import { BackendError, RemoteModel, RemoteTitleFormat } from '../execute/port-link.ts'

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

test('loadBaseConfig：schema 默认值与硬顶一致', () => {
  const config = loadBaseConfig()
  assert.equal(config.maxChars, 10)
  assert.equal(config.maxTokens, 64)
  assert.equal(config.timeoutMs, 15000)
  assert.ok(config.prompt.includes('只输出标题本身'))
})

test('resolveConfig：args 覆盖可调项，字数上限钳制到 1..10', () => {
  const base = loadBaseConfig()
  const overridden = resolveConfig(base, {
    max_chars: 3,
    max_tokens: 8,
    timeout_ms: 50,
    prompt: 'P',
  })
  assert.equal(overridden.maxChars, 3)
  assert.equal(overridden.maxTokens, 8)
  assert.equal(overridden.timeoutMs, 50)
  assert.equal(overridden.prompt, 'P')
  assert.equal(resolveConfig(base, { max_chars: 999 }).maxChars, HARD_MAX_CHARS)
  assert.equal(resolveConfig(base, { max_chars: 0 }).maxChars, base.maxChars)
})

test('RemoteModel：单次调用超时作结构化失败（按 timeoutMs 提前收口）', async () => {
  // 写帧为空实现：无应答，由 SDK PortLink 的逐次 timeoutMs 提前收口。
  const link = new PortLink({ write: () => {}, timeoutMs: 30 })
  const model = new RemoteModel(link)
  const started = Date.now()
  await assert.rejects(
    model.complete({ vendor: 'v', model: 'm' }, [{ role: 'user', content: 'x' }], 8, 30),
    (err) => err instanceof BackendError && err.code === 'transport_failed',
  )
  assert.ok(Date.now() - started < 2000, '超时应提前收口而非等待宿主超时')
})

test('RemoteTitleFormat：经反向 port.call 调 title-format.resolve 并回收 title', async () => {
  const link = fakeLink(() => ({ ok: true, value: { title: '快速排序算法' } }))
  const backend = new RemoteTitleFormat(link)
  const title = await backend.resolve('"快速排序算法。"', '帮我写一个快速排序', 10, '新对话')
  assert.equal(title, '快速排序算法')
  assert.equal(link.calls.length, 1)
  assert.equal(link.calls[0].port, 'title-format')
  assert.equal(link.calls[0].method, 'resolve')
  assert.deepEqual(link.calls[0].args, {
    model_text: '"快速排序算法。"',
    first_message: '帮我写一个快速排序',
    max_chars: 10,
    title_default: '新对话',
  })
  assert.ok(link.calls[0].options.timeoutMs > 0, '应带严格小于 generate 上限的逐次 timeoutMs')
})

test('RemoteTitleFormat：port 失败 / 回包缺 title → 结构化 BackendError', async () => {
  const failed = new RemoteTitleFormat(
    fakeLink(() => ({ ok: false, code: 'bad_args', message: 'x' })),
  )
  await assert.rejects(
    failed.resolve(null, '消息', 10, '新对话'),
    (err) => err instanceof BackendError && err.code === 'bad_args',
  )
  const missing = new RemoteTitleFormat(fakeLink(() => ({ ok: true, value: {} })))
  await assert.rejects(
    missing.resolve(null, '消息', 10, '新对话'),
    (err) => err instanceof BackendError && err.code === 'title_format_failed',
  )
})
