import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildPackage } from '../build.ts'

/** 仓库随带的 toy 包：`terms.src/` 是糖化源，`terms/` 是已提交的编译产物。 */
const FIXTURES = [
  fileURLToPath(new URL('../../fixtures/plugins/toy-term', import.meta.url)),
  fileURLToPath(new URL('../../fixtures/plugins/toy-router', import.meta.url)),
]

function collectFiles(dir: string, prefix = ''): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? dirent.name : `${prefix}/${dirent.name}`
    const abs = join(dir, dirent.name)
    if (dirent.isDirectory()) for (const [k, v] of collectFiles(abs, rel)) out.set(k, v)
    else if (dirent.isFile()) out.set(rel, readFileSync(abs))
  }
  return out
}

function withFreshBuild(fixture: string, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'chrono-toy-term-'))
  try {
    cpSync(fixture, dir, { recursive: true })
    // 先删掉随带产物，证明结果确实来自本次编译而非拷贝
    rmSync(join(dir, 'terms'), { recursive: true, force: true })
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('toy 包：糖化源 → 编译产物', () => {
  for (const fixture of FIXTURES) {
    const label = fixture.split(/[\\/]/).pop() as string

    it(`${label}：对 fixture 副本编译的产物与仓库随带 terms/ 逐字节一致（编译确定性）`, () => {
      withFreshBuild(fixture, (dir) => {
        const result = buildPackage(dir)
        expect(result.ok).toBe(true)
        const committed = collectFiles(join(fixture, 'terms'))
        const built = collectFiles(join(dir, 'terms'))
        expect([...built.keys()].sort()).toEqual([...committed.keys()].sort())
        for (const [rel, bytes] of committed) {
          expect(built.get(rel)?.equals(bytes), rel).toBe(true)
        }
      })
    })

    it(`${label}：同源两次编译逐字节一致`, () => {
      withFreshBuild(fixture, (dir) => {
        expect(buildPackage(dir).ok).toBe(true)
        const first = collectFiles(join(dir, 'terms'))
        rmSync(join(dir, 'terms'), { recursive: true, force: true })
        expect(buildPackage(dir).ok).toBe(true)
        const second = collectFiles(join(dir, 'terms'))
        expect([...second.keys()].sort()).toEqual([...first.keys()].sort())
        for (const [rel, bytes] of first) expect(second.get(rel)?.equals(bytes), rel).toBe(true)
      })
    })
  }
})
