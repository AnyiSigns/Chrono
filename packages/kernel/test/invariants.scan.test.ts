// 运行时零 IO 静态扫描：内核运行时文件（非 *.test.ts）的 import 全为相对路径，正文不含
// 时钟 / 随机 / 网络 / 进程 / 动态装载 token——内核运行的 IO 与不确定性入口必须为零。
// 本文件自身的 node:fs / node:url 属于豁免登记：仅测试环境读源码，不进内核运行时路径。
// @ts-ignore 工具链白名单不含 @types/node：本测试文件用 node fs 读源码（豁免见文件头）
import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const SRC_DIR = decodeURIComponent(
  (import.meta as unknown as { url: string }).url.replace(/^file:\/\/\//, ''),
).replace(/\/test\/[^/]*$/, '/')
const RUNTIME_FILES = [
  'index.ts',
  'types.ts',
  'value.ts',
  'hash.ts',
  'hash.utf8.ts',
  'defs.ts',
  'journal.ts',
  'journal.id.ts',
  'journal.apply.ts',
  'commit.ts',
  'commit.form.ts',
  'machine.ts',
  'run.ts',
]
function runtimeSources(): [string, string][] {
  return (readdirSync(SRC_DIR) as string[])
    .filter(
      (f: string) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.config.ts'),
    )
    .map((f: string) => [f, String(readFileSync(SRC_DIR + f, 'utf8'))])
}

describe('运行时零 IO：非 test 源码扫描（node:fs 豁免见文件头登记）', () => {
  it('import 仅相对路径；正文无 node: / Date. / Math.random / fetch( / process. / require( 痕迹', () => {
    const offenders: string[] = []
    const SPECS: [RegExp, string][] = [
      [/['"`]node:/, 'node: 说明符'],
      [/\bDate\./, 'Date.'],
      [/Math\.random/, 'Math.random'],
      [/\bfetch\s*\(/, 'fetch('],
      [/\bprocess\./, 'process.'],
      [/\brequire\s*\(/, 'require('],
    ]
    const IMPORT_RES = [/\bfrom\s+(['"])([^'"]*)\1/g, /(?:^|\n)[ \t]*import\s+(['"])([^'"]*)\1/g]
    for (const [f, src] of runtimeSources()) {
      for (const re of IMPORT_RES) {
        for (const m of src.matchAll(re)) {
          if (!m[2].startsWith('.')) offenders.push(f + ': 非相对 import ' + m[2])
        }
      }
      for (const [re, name] of SPECS) if (re.test(src)) offenders.push(f + ': 出现 ' + name)
    }
    expect(offenders).toEqual([])
  })
  it('扫描确有覆盖：index 与全部运行时文件都在扫描名单内', () => {
    const names = runtimeSources().map(([f]) => f)
    expect(names.length).toBeGreaterThanOrEqual(RUNTIME_FILES.length)
    expect(RUNTIME_FILES.every((f) => names.includes(f))).toBe(true)
    for (const f of RUNTIME_FILES) {
      expect(readFileSync(SRC_DIR + f, 'utf8').length).toBeGreaterThan(0)
    }
  })
})
