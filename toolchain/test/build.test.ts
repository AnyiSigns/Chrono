import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPackage } from '../build.ts'

describe('buildPackage：内联 step 的产物落盘', () => {
  it('生成 term 写进 terms/__gen/，源 term 的 $ref 指向它', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrono-toolchain-'))
    try {
      mkdirSync(join(dir, 'terms.src'))
      writeFileSync(join(dir, 'plugin.json'), '{}')
      writeFileSync(
        join(dir, 'terms.src', 'pick.json'),
        JSON.stringify({
          k: 'fold',
          coll: { k: 'ctx', path: ['xs'] },
          init: { k: 'lit', v: 0 },
          step: {
            k: 'if',
            cond: { k: 'pred', op: 'gt', a: { k: 'arg', i: 1 }, b: { k: 'arg', i: 0 } },
            then: { k: 'arg', i: 1 },
            else: { k: 'arg', i: 0 },
          },
        }),
      )

      const result = buildPackage(dir)
      expect(result.ok).toBe(true)
      expect(readdirSync(join(dir, 'terms', '__gen'))).toHaveLength(1)

      const ast = JSON.parse(readFileSync(join(dir, 'terms', 'pick.json'), 'utf8')) as unknown[]
      expect(ast[0]).toBe('fold')
      const ref = (ast[3] as unknown[])[1] as { $ref: string }
      expect(ref.$ref.startsWith('terms/__gen/')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('校验不过不写产物', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrono-toolchain-'))
    try {
      mkdirSync(join(dir, 'terms.src'))
      writeFileSync(join(dir, 'plugin.json'), '{}')
      writeFileSync(
        join(dir, 'terms.src', 'bad.json'),
        JSON.stringify({ k: 'eff', port: 'nope', method: 'm', args: { k: 'lit', v: null } }),
      )
      const result = buildPackage(dir)
      expect(result.ok).toBe(false)
      expect(result.issues.map((i) => i.message)).toContain('undeclared_port: nope')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
