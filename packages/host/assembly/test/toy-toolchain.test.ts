import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eval as evaluate } from '../../../kernel/index.ts'
import type { Env, Term } from '../../../kernel/machine.ts'
import {
  parsePluginDecl,
  resolveCommand,
  readPluginDecl,
} from '../index.ts'
import { runSeed } from '../../offline.ts'
import { validatePackage } from '../../validate-package.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { collectTreePaths } from '../../test/test-helpers-ext.ts'
import type { Json, World } from '../../../kernel/index.ts'

const TERM_FIXTURE = fileURLToPath(
  new URL('../../../../fixtures/plugins/toy-term', import.meta.url),
)

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

/** 递归读包内文本文件为 validate_package 的候选文件表（`node_modules` / `.git` 通用排除）。 */
function readPackageFiles(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name === '.git') continue
    const rel = prefix.length === 0 ? dirent.name : `${prefix}/${dirent.name}`
    const abs = join(dir, dirent.name)
    if (dirent.isDirectory()) Object.assign(out, readPackageFiles(abs, rel))
    else if (dirent.isFile()) out[rel] = readFileSync(abs, 'utf8')
  }
  return out
}

function evaluateTerm(world: World, entry: string, ctx: Json): ReturnType<typeof evaluate> {
  const env: Env = {
    ctx,
    args: [],
    defs: world.defs,
    results: {},
    caps: {},
    limits: { gas: 100000, depth: 64 },
    run: 'toy-term-test',
    i: 0,
    n: 0,
    gas: 100000,
    depth: 0,
    peakDepth: 0,
  }
  const body = world.defs[entry]?.body as Term
  return evaluate(body, env)
}

describe('toy 通路：糖化源 → 构建产物 → 入世 → eval', () => {
  it('plugin.json.build 声明工具链编译步，产物 terms/ 在入世树内、terms.src/ 被排除', async () => {
    const root = createTempRoot()
    try {
      const decl = parsePluginDecl(JSON.parse(readFileSync(join(TERM_FIXTURE, 'plugin.json'), 'utf8')) as Json)
      expect(decl.ok).toBe(true)
      if (decl.ok) {
        expect(decl.decl.build).toEqual([{ cmd: 'node', args: ['../../../toolchain/build.ts', '.'] }])
      }

      const report = runSeed(root, [{ name: 'toy-term', path: TERM_FIXTURE }])
      expect(report.ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const read = readPluginDecl(world, 'toy-term', hostPaths(root).blobsDir)
      expect(read).not.toBeNull()
      const paths = collectTreePaths(world, read!.tree)
      // 编译产物是定义本体，随包入世；糖化源是作者侧派生物，被 .worldignore 排除。
      expect(paths).toContain('terms/best.json')
      expect(paths.some((p) => p.startsWith('terms.src'))).toBe(false)
      expect(paths.some((p) => p.startsWith('test'))).toBe(false)
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('入世后按命令解析到产物 term，eval 出判定结果', async () => {
    const root = createTempRoot()
    try {
      const report = runSeed(root, [{ name: 'toy-term', path: TERM_FIXTURE }])
      expect(report.ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const command = resolveCommand(world, 'toy-term.best', hostPaths(root).blobsDir)
      expect(command).not.toBeNull()

      const result = evaluateTerm(world, command!.entry, {
        cands: [
          { id: 'a', score: 1 },
          { id: 'b', score: 3 },
          { id: 'c', score: 2 },
        ],
      })
      expect(result).toEqual({ ok: true, value: 'b' })

      const single = evaluateTerm(world, command!.entry, { cands: [{ id: 'only', score: 9 }] })
      expect(single).toEqual({ ok: true, value: 'only' })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('validate_package dry-run 对同一包不回归：接受且产物哈希非空', () => {
    const root = createTempRoot()
    try {
      const outcome = validatePackage(
        emptyWorld(),
        join(root, 'state', 'runtime'),
        readPackageFiles(TERM_FIXTURE),
        hostPaths(root).blobsDir,
        root,
      )
      expect(outcome.accepted).toBe(true)
      if (outcome.accepted) {
        expect(outcome.report.ok).toBe(true)
        expect(outcome.report.result_hash).not.toBeNull()
      }
      // dry-run 不写世界、不落 CAS
      expect(Object.keys(loadAnchor(`${root}/state/world/journal.jsonl`).world.ids)).toHaveLength(0)
    } finally {
      cleanupTempRoot(root)
    }
  })
})
