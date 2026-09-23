// 单元级测试：v1 估算器规格向量（原生实现）、policy 解析、前缀和、规范化键、预算建模。
// 与 Rust `cargo test` 的规格向量保持一致——两处同口径，锁定「同输入同输出」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureNative } from './driver.mjs'

process.env.CHRONO_PLUGIN_STATE = ''
ensureNative()

const native = await import('../execute/native.ts')
const { parsePolicy, defaultPolicy, loadPolicy } = await import('../execute/policy.ts')
const {
  prefixSums,
  rangeSum,
  computeDedupKey,
  computeContentKey,
  normalizeText,
  countParts,
  cachedDedupKey,
  cacheSizes,
  CACHE_MAX_ENTRIES,
} = await import('../execute/text.ts')
const { computeBudget } = await import('../execute/budget.ts')
const { planHistory } = await import('../execute/history.ts')
const { parseRawParts, messageParts } = await import('../execute/history.ts')

test('parts 宽松解析：展示专用 tool / reasoning part 不进模型上下文', () => {
  const parsed = parseRawParts([
    { type: 'reasoning', text: '思考' },
    { type: 'text', text: '正文' },
    { type: 'tool', call_id: 'c1', tool: 'read', render: { form: 'line' }, result: {} },
  ])
  assert.deepEqual(parsed.parts, [{ type: 'text', text: '正文' }])
  assert.equal(parsed.hasToolCall, false)
  // 只剩展示 part 且 content 为空 → 空 parts（不留空消息）
  assert.deepEqual(messageParts({ content: '', parts: [{ type: 'reasoning', text: 'x' }] }).parts, [])
  // content 非空仍回落正文
  assert.deepEqual(messageParts({ content: 'hi' }).parts, [{ type: 'text', text: 'hi' }])
})

test('估算器规格向量：ASCII / CJK / 混合 / 空串 / 其他文字', () => {
  assert.equal(native.countTokens(''), 0)
  assert.equal(native.countTokens('   \n\t'), 0)
  assert.equal(native.countTokens('hello'), 1)
  assert.equal(native.countTokens('hello world'), 2)
  assert.equal(native.countTokens('你好'), 2)
  assert.equal(native.countTokens('你好，世界'), 5)
  assert.equal(native.countTokens('Hello世界!'), 4)
  assert.equal(native.countTokens('foo(bar, baz)'), 4)
  assert.equal(native.countTokens('Привет'), 2)
  assert.equal(native.tokenizerVersion(), 'v1')
})

test('估算器确定性：同输入两次同输出', () => {
  const sample = 'The quick brown fox 中文测试 12345. '.repeat(50)
  assert.equal(native.countTokens(sample), native.countTokens(sample))
})

test('policy：缺键回落默认；非法顶层抛错', () => {
  const parsed = parsePolicy({ version: 2, budget: { margin_ratio: 0.1 } })
  assert.equal(parsed.version, 2)
  assert.equal(parsed.budget.margin_ratio, 0.1)
  assert.equal(parsed.budget.default_context_window, defaultPolicy().budget.default_context_window)
  assert.equal(parsed.messages.compress_hint, defaultPolicy().messages.compress_hint)
  assert.throws(() => parsePolicy(null), /must be a JSON object/)
})

test('policy：随包 policy.json 可加载且前缀边界正确', () => {
  const policy = loadPolicy()
  assert.deepEqual(policy.prefix.stable, ['prompt', 'tools'])
  assert.deepEqual(policy.prefix.order, ['l2', 'l1', 'skill', 'recall', 'history', 'style'])
  assert.equal(policy.thresholds.compress_hint_ratio, 0.75)
})

test('前缀和与区间求和', () => {
  const sums = prefixSums([1, 2, 3, 4])
  assert.deepEqual(sums, [0, 1, 3, 6, 10])
  assert.equal(rangeSum(sums, 1, 3), 5)
  assert.equal(rangeSum(sums, 0, 4), 10)
})

test('规范化键：空白差异等价；角色参与 dedup_key、不参与 content_key', () => {
  assert.equal(normalizeText('  a   b \n c '), 'a b c')
  const parts = [{ type: 'text', text: 'a  b' }]
  assert.equal(computeDedupKey('user', parts), computeDedupKey('user', [{ type: 'text', text: 'a b' }]))
  assert.notEqual(computeDedupKey('user', parts), computeDedupKey('system', parts))
  assert.equal(computeContentKey(parts), computeContentKey([{ type: 'text', text: 'a b' }]))
})

test('预算建模：缺档案回落默认并标 profile_missing', () => {
  const policy = defaultPolicy()
  const missing = computeBudget(null, policy)
  assert.equal(missing.context_window, policy.budget.default_context_window)
  assert.equal(missing.max_output, policy.budget.default_max_output)
  assert.ok(missing.flags.includes('profile_missing'))
  const explicit = computeBudget({ context_window: 1000, max_output: 100 }, policy)
  assert.equal(explicit.budget, 1000 - 100 - 50)
  assert.deepEqual(explicit.flags, [])
})

test('历史还原：head 为空/不在 refs 即空历史，绝不从会话级全量 refs 猜链头（防串会话）', () => {
  // 会话级 refs 含另一会话的消息链（count 2），但本会话 head = null（尚无消息）
  const other = { id: 'msg-other-0', role: 'user', content: '别的会话', prev: null }
  const other2 = { id: 'msg-other-1', role: 'assistant', content: '回答', prev: { def: 'h-other-0' } }
  const refs = { 'h-other-0': other, 'h-other-1': other2 }
  const empty = planHistory({ session: { head: null, refs } })
  assert.deepEqual(empty.chain, [], '本会话无 head → 历史必须为空')
  const dangling = planHistory({ session: { head: 'h-missing', refs } })
  assert.deepEqual(dangling.chain, [], 'head 不在 refs → 不猜链头，历史为空')

  // 本会话有 head：沿 prev 还原，只含本会话链
  const a = { id: 'msg-cur-0', role: 'user', content: 'A', prev: null }
  const b = { id: 'msg-cur-1', role: 'assistant', content: 'B', prev: { def: 'h-cur-0' } }
  const scoped = planHistory({ session: { head: 'h-cur-1', refs: { ...refs, 'h-cur-0': a, 'h-cur-1': b } } })
  assert.deepEqual(
    scoped.chain.map((entry) => entry.body.id),
    ['msg-cur-0', 'msg-cur-1'],
  )
})

test('缓存有界：超过上限按 LRU 淘汰，不单调增长', () => {
  const parts = [{ type: 'text', text: 'x' }]
  for (let i = 0; i < CACHE_MAX_ENTRIES + 100; i += 1) countParts(parts, `k-${i}`)
  assert.equal(cacheSizes().tokens, CACHE_MAX_ENTRIES)
  for (let i = 0; i < CACHE_MAX_ENTRIES + 100; i += 1) cachedDedupKey(`n-${i}`, 'user', parts)
  assert.equal(cacheSizes().normalize, CACHE_MAX_ENTRIES)
})
