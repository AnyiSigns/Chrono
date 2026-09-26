// 受保护 pin 运营配置：`chrono.config.json` 的 `protected_pins` 键 + `CHRONO_PROTECTED_PINS` 覆盖。
// 缺失 → 空集 + 运维日志（fail-open，故有兜底断言）；非法 → fail-closed `bad_protected_pins`。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readProtectedPins } from '../protected-pins.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { readLifecycle, writeChronoConfig } from './test-helpers-ext.ts'
import type { Json } from '../../kernel/index.ts'

const SIX = ['sandbox', 'guard', 'secrets', 'approval', 'storage-sql', 'storage-kv']

/** 随仓库提交的 `chrono.config.json`（从本测试文件回溯到仓库根）。 */
const SHIPPED_CONFIG = fileURLToPath(new URL('../../../chrono.config.json', import.meta.url))

/** 直接写 `chrono.config.json`（ASCII JSON），用于构造非法形态。 */
function writeRawConfig(root: string, value: Json): void {
  const file = join(root, 'chrono.config.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(value))
}

describe('受保护 pin 运营配置', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    vi.unstubAllEnvs()
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await cleanupTempRoot(root)
  })

  it('随仓库的 chrono.config.json 恰含六个受保护身份（删一个即红）', () => {
    const parsed = JSON.parse(readFileSync(SHIPPED_CONFIG, 'utf8')) as {
      protected_pins?: Json
    }
    expect(parsed.protected_pins).toEqual(SIX)
  })

  it('从文件读名单；同一份读取结果与声明一致', () => {
    writeChronoConfig(root, SIX)
    const read = readProtectedPins(root)
    expect(read.reason).toBeUndefined()
    expect([...read.identities].sort()).toEqual([...SIX].sort())
  })

  it('CHRONO_PROTECTED_PINS 覆盖文件（逗号分隔）', () => {
    writeChronoConfig(root, ['from-file'])
    vi.stubEnv('CHRONO_PROTECTED_PINS', 'a, b ,c')
    const read = readProtectedPins(root)
    expect(read.reason).toBeUndefined()
    expect([...read.identities].sort()).toEqual(['a', 'b', 'c'])
  })

  it('非法文件形态（非字符串数组 / 空串项）→ bad_protected_pins', () => {
    // 非字符串数组
    writeRawConfig(root, { protected_pins: 'sandbox,guard' })
    expect(readProtectedPins(root).reason).toBe('bad_protected_pins')
    // 空串项
    writeRawConfig(root, { protected_pins: ['sandbox', ''] })
    expect(readProtectedPins(root).reason).toBe('bad_protected_pins')
  })

  it('非法环境覆盖 → bad_protected_pins（fail-closed）', () => {
    writeChronoConfig(root, SIX)
    vi.stubEnv('CHRONO_PROTECTED_PINS', 'sandbox,,guard')
    expect(readProtectedPins(root).reason).toBe('bad_protected_pins')
  })

  it('文件缺失 → 空集 + 运维日志（fail-open）', () => {
    const read = readProtectedPins(root)
    expect(read.reason).toBeUndefined()
    expect(read.identities.size).toBe(0)
    const log = readLifecycle(hostPaths(root).lifecycleFile)
    expect(log.some((entry) => entry.event === 'protected_pins_unset')).toBe(true)
  })
})
