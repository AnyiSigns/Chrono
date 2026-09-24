// 水位单元测试：单调前进（不回退）与原子替换（无临时残留）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atOrBefore, readWatermark, writeWatermark } from '../execute/watermark.ts'

const FILE_NAME = 'sweep-watermark.json'

test('writeWatermark：仅当前进，落后游标不覆盖；原子写无临时残留', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-'))
  const previous = process.env.CHRONO_PLUGIN_STATE
  process.env.CHRONO_PLUGIN_STATE = dir
  try {
    writeWatermark('2024-01-01T00:00:00.000Z')
    assert.equal(readWatermark(), '2024-01-01T00:00:00.000Z')
    assert.deepEqual(readdirSync(dir), [FILE_NAME])

    // 回退写被忽略
    writeWatermark('2023-01-01T00:00:00.000Z')
    assert.equal(readWatermark(), '2024-01-01T00:00:00.000Z')
    assert.equal(JSON.parse(readFileSync(join(dir, FILE_NAME), 'utf8')).cursor, '2024-01-01T00:00:00.000Z')

    // 前进写落盘
    writeWatermark('2025-01-01T00:00:00.000Z')
    assert.equal(readWatermark(), '2025-01-01T00:00:00.000Z')
    assert.deepEqual(readdirSync(dir), [FILE_NAME])
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }
})

test('时间归一：带偏移 / 不同精度 ISO 不按字典序误判前进方向', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wm-offset-'))
  const previous = process.env.CHRONO_PLUGIN_STATE
  process.env.CHRONO_PLUGIN_STATE = dir
  try {
    writeWatermark('2024-01-01T00:00:00.000Z')
    // 05:00+06:00 = 前一日 23:00Z（更早），但字典序更大：不得覆盖
    writeWatermark('2024-01-01T05:00:00+06:00')
    assert.equal(readWatermark(), '2024-01-01T00:00:00.000Z')
    // 08:00+06:00 = 当日 02:00Z（更晚）：应前进
    writeWatermark('2024-01-01T08:00:00+06:00')
    assert.equal(readWatermark(), '2024-01-01T08:00:00+06:00')
  } finally {
    if (previous === undefined) delete process.env.CHRONO_PLUGIN_STATE
    else process.env.CHRONO_PLUGIN_STATE = previous
    rmSync(dir, { recursive: true, force: true })
  }

  assert.equal(atOrBefore('2024-01-01T05:00:00+06:00', '2024-01-01T00:00:00.000Z'), true)
  assert.equal(atOrBefore('2024-01-01T08:00:00+06:00', '2024-01-01T00:00:00.000Z'), false)
  // 无法解析时回落字典序（相等即不晚于）
  assert.equal(atOrBefore('not-a-date', 'not-a-date'), true)
})
