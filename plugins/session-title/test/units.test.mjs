// 纯函数级测试：schema 配置装载 + 后端抽象 + 标题后处理原语（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HARD_MAX_CHARS, loadBaseConfig, resolveConfig } from '../execute/config.ts'
import { PortLink } from 'plugin-sdk'
import { BackendError, RemoteModel } from '../execute/port-link.ts'
import {
  cleanModelTitle,
  fallbackTitle,
  normalizeWhitespace,
  resolveTitle,
  truncateCodePoints,
} from '../execute/title.ts'

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

test('truncateCodePoints：按码点截断，CJK 每字 = 1、不劈代理对', () => {
  assert.equal(truncateCodePoints('你好世界', 2), '你好')
  assert.equal(truncateCodePoints('你好世界', 10), '你好世界')
  assert.equal(truncateCodePoints('😀😀😀', 2), '😀😀')
  assert.equal(Array.from(truncateCodePoints('😀😀😀', 2)).length, 2)
})

test('normalizeWhitespace：折叠空白并去首尾', () => {
  assert.equal(normalizeWhitespace('  你好\n\n世界  '), '你好 世界')
})

test('cleanModelTitle：取首个非空行、去引号 / 换行 / 结尾标点', () => {
  assert.equal(cleanModelTitle('「你好，世界。」', 10), '你好，世界')
  assert.equal(cleanModelTitle('"排序算法。"', 10), '排序算法')
  assert.equal(cleanModelTitle('\n\n  快速排序。  \n第二行', 10), '快速排序')
  assert.equal(cleanModelTitle('这是一个很长的标题需要被截断处理', 10), '这是一个很长的标题需')
})

test('fallbackTitle：首条消息去空白后前 N 字', () => {
  assert.equal(fallbackTitle('  帮我写一个快速排序算法  ', 10), '帮我写一个快速排序算')
  assert.equal(fallbackTitle('   ', 10), '')
})

test('resolveTitle：模型 → 首条消息 → 缺省标题 的兜底顺序', () => {
  assert.equal(resolveTitle('模型标题', '首条消息', 10, '新对话'), '模型标题')
  assert.equal(resolveTitle('', '帮我写一个快速排序算法', 10, '新对话'), '帮我写一个快速排序算')
  assert.equal(resolveTitle(null, '   ', 10, '我的标题'), '我的标题')
})
