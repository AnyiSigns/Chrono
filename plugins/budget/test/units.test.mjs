// 纯函数级 / 状态级测试：预算建模、真实用量解析、EWMA 系数、③ 状态落盘。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.CHRONO_PLUGIN_STATE = ''

const { computeBudget, parseParams, DEFAULT_PARAMS } = await import('../execute/model.ts')
const { parseUsage, observeUsage, correctionFactor, resetCalibration } =
  await import('../execute/calibration.ts')

test('预算建模：缺档案回落默认并标 profile_missing', () => {
  const missing = computeBudget(DEFAULT_PARAMS)
  assert.equal(missing.origin, 'default')
  assert.ok(missing.flags.includes('profile_missing'))
  assert.equal(missing.context_window, 8192)
  assert.equal(missing.budget, 8192 - 1024 - Math.floor(8192 * 0.05))
})

test('预算建模：档案给出窗口 / 输出；输出封顶到半个窗口', () => {
  const explicit = computeBudget({
    ...DEFAULT_PARAMS,
    config: { context_window: 1000, max_output: 100 },
  })
  assert.equal(explicit.origin, 'profile')
  assert.equal(explicit.flags.length, 0)
  assert.equal(explicit.context_window, 1000)
  assert.equal(explicit.max_output, 100)
  assert.equal(explicit.margin, 50)
  assert.equal(explicit.budget, 850)

  const capped = computeBudget({
    ...DEFAULT_PARAMS,
    config: { context_window: 1000, max_output: 2000 },
  })
  assert.equal(capped.max_output, 500)
  assert.equal(capped.budget, 1000 - 500 - 50)
})

test('预算建模：配额按预算比例取整', () => {
  const result = computeBudget({
    ...DEFAULT_PARAMS,
    config: { context_window: 1000, max_output: 100 },
  })
  assert.equal(result.quota.l2, Math.floor(850 * 0.08))
  assert.equal(result.quota.recall, Math.floor(850 * 0.12))
})

test('参数归一化：缺键回落默认', () => {
  const parsed = parseParams({ config: { context_window: 100, max_output: 10 } })
  assert.equal(parsed.margin_ratio, DEFAULT_PARAMS.margin_ratio)
  assert.equal(parsed.quota.l1, DEFAULT_PARAMS.quota.l1)
  assert.deepEqual(parsed.config, { context_window: 100, max_output: 10 })
})

test('用量解析：缓存命中字段与完成 token', () => {
  const usage = parseUsage({ prompt_tokens: 100, cached_tokens: 40, completion_tokens: 5 })
  assert.equal(usage.prompt_tokens, 100)
  assert.equal(usage.cached_tokens, 40)
  assert.equal(usage.hit_rate, 0.4)
  assert.equal(parseUsage({}), null)
  assert.equal(parseUsage({ input_tokens: 10, cache_read_input_tokens: 5 }).cached_tokens, 5)
})

test('校准：EWMA 更新每模型系数，可重置', () => {
  resetCalibration()
  assert.equal(correctionFactor('m'), 1)
  observeUsage('m', 100, null)
  const factor = observeUsage('m', 100, {
    prompt_tokens: 200,
    cached_tokens: 0,
    cache_creation_tokens: 0,
    completion_tokens: 0,
    hit_rate: 0,
    correction_factor: null,
  })
  assert.ok(Math.abs(factor - 1.2) < 1e-9)
  assert.equal(correctionFactor('m'), factor)
  resetCalibration()
  assert.equal(correctionFactor('m'), 1)
})

test('校准：系数未变不重写状态文件，变化才落盘', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-cal-'))
  const file = join(dir, 'calibration.json')
  const previous = process.env.CHRONO_PLUGIN_STATE
  try {
    writeFileSync(file, JSON.stringify({ m: { factor: 1, last_estimate: 100 } }), 'utf8')
    process.env.CHRONO_PLUGIN_STATE = dir
    resetCalibration()
    observeUsage('m', 200, null)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      m: { factor: 1, last_estimate: 100 },
    })
    observeUsage('m', 300, {
      prompt_tokens: 400,
      cached_tokens: 0,
      cache_creation_tokens: 0,
      completion_tokens: 0,
      hit_rate: 0,
      correction_factor: null,
    })
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(Math.abs(saved.m.factor - 1.2) < 1e-9)
    assert.equal(saved.m.last_estimate, 300)
  } finally {
    process.env.CHRONO_PLUGIN_STATE = previous
    resetCalibration()
    rmSync(dir, { recursive: true, force: true })
  }
})
