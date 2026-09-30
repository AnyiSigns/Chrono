// `files` 发布清单必须覆盖全部根源文件与源码目录，防止新增源文件 / 目录时漏列。

import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 随源码发布的根目录源码目录（`test/` 不发布）。 */
const SOURCE_DIRS = [
  'assembly/',
  'common/',
  'effect/',
  'inbound/',
  'ledger/',
  'projection/',
  'watch/',
]

describe('host package.json files 清单', () => {
  it('覆盖全部根源 .ts 与源码目录', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')) as {
      files: string[]
    }
    const listed = new Set(pkg.files)
    const rootSources = readdirSync(PKG_DIR).filter(
      (name) => name.endsWith('.ts') && name !== 'vitest.config.ts',
    )
    for (const name of rootSources) {
      expect(listed.has(name), `files 缺根源文件 ${name}`).toBe(true)
    }
    for (const dir of SOURCE_DIRS) {
      expect(listed.has(dir), `files 缺源码目录 ${dir}`).toBe(true)
    }
    // 新纳入的源码目录其 test/ 子目录一并排除，避免测试随包发布
    expect(listed.has('!inbound/test/')).toBe(true)
    expect(listed.has('!watch/test/')).toBe(true)
  })
})
