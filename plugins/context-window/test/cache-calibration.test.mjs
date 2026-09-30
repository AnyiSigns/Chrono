// 缓存提示与 token 校准消费的专项测试。
// - `context.build` 产出厂商中立的 `cache` 提示：稳定前缀（系统提示 → 工具）非空时可缓存；
//   前缀为空（无可缓存内容）时不产出 `cache`；系统角色消息若含前缀外的易变切片则只给 `key`、不标 `system`。
// - `key` 是静态前缀的稳定哈希：前缀变则键变，仅输入 / 技能变则键不变，连续组装逐字节一致。
// - 校准消费者：随 `bag.usage` 到达的真实用量经 `budget.observe` 回填 manifest；系数在快路径（含改写路径）上生效。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { baseBag, chainOf, startService, FIXED_ENV } from './driver.mjs'
import { createFakeBackends, createFakeBudget } from './fakes.mjs'

const { buildAssembly } = await import('../execute/pipeline.ts')
const { defaultPolicy } = await import('../execute/policy.ts')

process.env.CHRONO_PLUGIN_STATE = ''

// ── 缓存提示 ───────────────────────────────────────────────────────────────

test('cache：稳定前缀（系统提示 → 工具）给出 system / tools / key', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(
      baseBag({
        system_prompt: 'P',
        tools: [{ name: 't1', schema: { type: 'object' } }],
      }),
    )
    assert.equal(value.ok, true)
    assert.ok(value.cache, '稳定前缀应产出 cache 提示')
    assert.equal(value.cache.system, true)
    assert.equal(value.cache.tools, true)
    assert.ok(typeof value.cache.key === 'string' && value.cache.key.startsWith('ctx-'))
    assert.equal(value.cache.breakpoints, undefined, '稳定前缀均为 system 角色，无需消息断点')

    const repeat = await drv.build(
      baseBag({
        system_prompt: 'P',
        tools: [{ name: 't1', schema: { type: 'object' } }],
      }),
    )
    assert.equal(repeat.cache.key, value.cache.key, '同前缀两次组装键一致')
  } finally {
    drv.close()
  }
})

test('cache：无可缓存前缀（无系统提示 / 工具 / L2）时不产出 cache', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const value = await drv.build(baseBag({ system_prompt: null, tools: [], memories: {} }))
    assert.equal(value.ok, true)
    assert.equal(value.cache, undefined)
  } finally {
    drv.close()
  }
})

test('cache：前缀外含系统角色易变切片（技能）时不标 system，但 key 仍由静态前缀决定', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const build = (skillText) =>
      drv.build(
        baseBag({
          system_prompt: 'P',
          tools: [{ name: 't1', schema: { type: 'object' } }],
          skills: [{ name: 's', content: skillText }],
        }),
      )
    const first = await build('技能-甲')
    assert.equal(first.cache.system, undefined, 'system 串含易变技能，标记会使缓存失效')
    assert.equal(first.cache.tools, true)
    const second = await build('技能-乙')
    assert.equal(second.cache.key, first.cache.key, '仅前缀外的技能变化不应改键')
  } finally {
    drv.close()
  }
})

test('cache：系统提示变化 → 键变化；连续两次组装 messages 与 cache 逐字节一致', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const bag = baseBag({
      system_prompt: 'P',
      tools: [{ name: 'a' }],
    })
    const first = await drv.build(bag)
    const second = await drv.build(bag)
    assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages))
    assert.equal(JSON.stringify(first.cache), JSON.stringify(second.cache))

    const changed = await drv.build(
      baseBag({ system_prompt: 'Q', tools: [{ name: 'a' }] }),
    )
    assert.notEqual(changed.cache.key, first.cache.key, '前缀内容变化应改键')
  } finally {
    drv.close()
  }
})

// ── 校准消费者 ─────────────────────────────────────────────────────────────

const CAL_BAG = {
  input: 'IN',
  system_prompt: 'P',
  session: chainOf([
    {
      id: 't1',
      role: 'assistant',
      content: '',
      parts: [
        {
          type: 'tool',
          call_id: 'c1',
          tool: 'read',
          args: { path: 'src/a.ts' },
          result: { content: 'z '.repeat(200), lines_returned: 200 },
          status: 'ok',
        },
      ],
    },
  ]),
  config: { model: 'cal-model', context_window: 100000, max_output: 100 },
}

test('校准：真实用法更新系数，系数作用于快路径与改写路径', async () => {
  const policy = defaultPolicy()
  const raw = await buildAssembly(CAL_BAG, { ...FIXED_ENV }, policy, createFakeBackends())
  assert.equal(raw.manifest.usage, null, '无 bag.usage 时不产出用量')

  const budget = createFakeBudget()
  assert.equal(budget.factor('cal-model'), 1)
  budget.observe('cal-model', 100, null)
  const factor = budget.observe('cal-model', 100, {
    prompt_tokens: 200,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    completion_tokens: 0,
    hit_rate: 0,
    correction_factor: null,
  }).factor
  assert.ok(Math.abs(factor - 1.2) < 1e-9, `系数应为 1.2，实得 ${factor}`)
  assert.equal(budget.factor('cal-model'), factor)

  const scaled = await buildAssembly(
    { ...CAL_BAG, usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 0 } },
    { ...FIXED_ENV },
    policy,
    createFakeBackends(budget),
  )
  assert.equal(scaled.manifest.usage.correction_factor, factor, 'manifest 记录的系数即本次装配所用')
  assert.ok(
    scaled.manifest.used > raw.manifest.used,
    `系数应放大快路径计数：raw=${raw.manifest.used} scaled=${scaled.manifest.used}`,
  )
})

test('校准：随 bag.usage 的真实用量进入 calibrator（消费者接通）', async () => {
  const policy = defaultPolicy()
  const budget = createFakeBudget()
  const backends = createFakeBackends(budget)
  const bag = { ...CAL_BAG, usage: { prompt_tokens: 100, cached_tokens: 40, completion_tokens: 5 } }
  const first = await buildAssembly(bag, { ...FIXED_ENV }, policy, backends)
  assert.equal(first.manifest.usage.prompt_tokens, 100)
  assert.equal(first.manifest.usage.cached_tokens, 40)
  assert.equal(first.manifest.usage.hit_rate, 0.4)
  assert.equal(
    first.manifest.usage.correction_factor,
    1,
    '首次只有估算、无上次估算可比，系数保持 1',
  )

  // 第二次带上真实用量：calibrator 已累积上次估算，系数据此更新（EWMA、有界）。
  const second = await buildAssembly(bag, { ...FIXED_ENV }, policy, backends)
  assert.equal(second.manifest.usage.correction_factor, 1, '本次装配用的是更新前的系数')
  const expected = Math.min(2, Math.max(0.5, 0.8 + 0.2 * (100 / first.manifest.used)))
  const after = budget.factor('cal-model')
  assert.ok(Math.abs(after - expected) < 1e-9, `系数应为 ${expected}，实得 ${after}`)
})
