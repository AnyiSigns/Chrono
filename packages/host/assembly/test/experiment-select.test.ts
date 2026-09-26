// 单判定实验：`router.select` 判定进 term 的三条端到端取证。
// 生产 router 插件不改；用 fixtures/plugins/toy-router 承载同一判定。
// ① 表达得出：入世后的产物 term 与生产语义逐例一致。
// ② 热改不换进程：只改 term 成员内容 → 换代判据为 data（宿主走 reload，不起新服务）。
// ③ 重放决策一致：同输入两次求值逐字段一致。

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { eval as evaluate } from '../../../kernel/index.ts'
import type { Env, Term } from '../../../kernel/machine.ts'
import { classifyGenerationChange, readPluginDecl, resolveCommand } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Gen, Json, World } from '../../../kernel/index.ts'

const TOY_ROUTER = fileURLToPath(new URL('../../../../fixtures/plugins/toy-router', import.meta.url))

const SELECT_INPUT: Json = { candidates: ['a', 'b'], aliases: ['b'], primary: 'a' }

/** 递归读 fixture 的 `terms/` 内容（含 `__gen/`），供构造 v2 临时包。 */
function readTerms(dir: string, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix.length === 0 ? dirent.name : `${prefix}/${dirent.name}`
    const abs = join(dir, dirent.name)
    if (dirent.isDirectory()) Object.assign(out, readTerms(abs, rel))
    else if (dirent.isFile()) out[rel] = readFileSync(abs, 'utf8')
  }
  return out
}

function evalSelect(world: World, blobsDir: string, input: Json): ReturnType<typeof evaluate> {
  const command = resolveCommand(world, 'toy-router.select', blobsDir)
  if (command === null) throw new Error('toy-router.select not resolved')
  const env: Env = {
    ctx: null,
    args: [input],
    defs: world.defs,
    results: {},
    caps: {},
    limits: { gas: 100000, depth: 64 },
    run: 'select-experiment',
    i: 0,
    n: 0,
    gas: 100000,
    depth: 0,
    peakDepth: 0,
  }
  return evaluate(world.defs[command.entry]?.body as Term, env)
}

function activeGen(world: World, id: string): Gen {
  const identity = world.ids[id]
  const gen = identity.gens.find((g) => g.payload === identity.active)
  if (gen === undefined) throw new Error('active gen missing')
  return gen
}

describe('实验：router.select 判定进 term（toy-router）', () => {
  it('① 表达得出：入世产物按命令解析后逐例给出正确决策', async () => {
    const root = createTempRoot()
    try {
      expect(runSeed(root, [{ name: 'toy-router', path: TOY_ROUTER }]).ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const blobsDir = hostPaths(root).blobsDir
      expect(evalSelect(world, blobsDir, SELECT_INPUT)).toEqual({ ok: true, value: 'b' })
      expect(
        evalSelect(world, blobsDir, { candidates: ['a', 'b'], aliases: [], primary: 'a' }),
      ).toEqual({ ok: true, value: 'a' })
      expect(
        evalSelect(world, blobsDir, { candidates: ['a'], aliases: [], primary: 'z' }),
      ).toEqual({ ok: true, value: { ok: false, error: { code: 'no_candidate' } } })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('② 热改不换进程：只改 term 成员内容 → 换代判据为 data；决策随之改变', async () => {
    const root = createTempRoot()
    try {
      expect(runSeed(root, [{ name: 'toy-router', path: TOY_ROUTER }]).ok).toBe(true)
      const v1 = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const blobsDir = hostPaths(root).blobsDir
      const v1Gen = activeGen(v1, 'toy-router')
      expect(evalSelect(v1, blobsDir, SELECT_INPUT)).toEqual({ ok: true, value: 'b' })

      // v2：同一 execute 成员，仅把 select 的判定体换成策略 B（primary 优先）。
      const terms = readTerms(join(TOY_ROUTER, 'terms'))
      const v2Pkg = writeTempPackage(root, {
        identity: 'toy-router',
        dir: 'toy-router-v2',
        start: 'node execute/main.js',
        implements: ['router'],
        methods: { router: ['select'] },
        members: [
          { kind: 'execute', path: 'execute/' },
          { kind: 'term', path: 'terms/' },
        ],
        commands: [{ name: 'toy-router.select', entry: 'terms/select.json' }],
        files: { 'execute/main.js': readFileSync(join(TOY_ROUTER, 'execute', 'main.js'), 'utf8') },
        terms: { ...terms, 'select.json': terms['select-v2.json'] as string },
      })
      expect(runSeed(root, [{ name: 'toy-router', path: v2Pkg }]).ok).toBe(true)
      const v2 = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const v2Gen = activeGen(v2, 'toy-router')

      // 只 term 变化：换代判据 data ⇒ 宿主 reload，服务进程不重启。
      expect(classifyGenerationChange(v1, v1Gen, v2, v2Gen, blobsDir)).toBe('data')
      // 判定改动确实生效：策略 B 在别名与主名冲突时回主名。
      expect(evalSelect(v2, blobsDir, SELECT_INPUT)).toEqual({ ok: true, value: 'a' })
    } finally {
      await cleanupTempRoot(root)
    }
  })

  it('③ 重放决策一致：同一入世世界重放后判定体与决策逐字段一致', async () => {
    const root = createTempRoot()
    try {
      expect(runSeed(root, [{ name: 'toy-router', path: TOY_ROUTER }]).ok).toBe(true)
      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const replayed = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const blobsDir = hostPaths(root).blobsDir
      const read = readPluginDecl(world, 'toy-router', blobsDir)
      const readReplayed = readPluginDecl(replayed, 'toy-router', blobsDir)
      expect(read?.tree).toBe(readReplayed?.tree)
      const first = evalSelect(world, blobsDir, SELECT_INPUT)
      const second = evalSelect(replayed, blobsDir, SELECT_INPUT)
      expect(second).toEqual(first)
    } finally {
      await cleanupTempRoot(root)
    }
  })
})
