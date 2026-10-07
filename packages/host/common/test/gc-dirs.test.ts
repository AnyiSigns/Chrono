import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gcDirs } from '../gc-dirs.ts'

describe('common/gc-dirs', () => {
  let dir: string

  const seed = (names: string[]): void => {
    for (const name of names) writeFileSync(join(dir, name), '')
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chrono-gc-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('缺目录即空报告', () => {
    expect(gcDirs(join(dir, 'missing'), { keep: () => true, remove: () => {} })).toEqual({
      scanned: 0,
      removed: [],
      kept: 0,
      failed: [],
    })
  })

  it('select 过滤后按 keep 删除，removed 排序，未命中项不碰', () => {
    seed(['a', 'b', 'c', 'skip'])
    const report = gcDirs(dir, {
      select: (name) => name !== 'skip',
      keep: (name) => name === 'b',
      remove: (name) => rmSync(join(dir, name), { force: true }),
    })
    expect(report.scanned).toBe(3)
    expect(report.kept).toBe(1)
    expect(report.removed).toEqual(['a', 'c'])
    expect(existsSync(join(dir, 'b'))).toBe(true)
    expect(existsSync(join(dir, 'skip'))).toBe(true)
  })

  it('onRemoveError=collect 记 failed 不阻断；throw 上抛', () => {
    seed(['a', 'b'])
    const collect = gcDirs(dir, {
      keep: () => false,
      remove: () => {
        throw new Error('nope')
      },
    })
    expect(collect.removed).toEqual([])
    expect(collect.failed.map((item) => item.name)).toEqual(['a', 'b'])
    expect(() =>
      gcDirs(dir, {
        keep: () => false,
        remove: () => {
          throw new Error('nope')
        },
        onRemoveError: 'throw',
      }),
    ).toThrow('nope')
  })
})
