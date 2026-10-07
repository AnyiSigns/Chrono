import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { collectRefs, replaceTermRefs, termTopoOrder } from '../term-refs.ts'
import { normalizeRefPath } from '../../common/paths-safe.ts'
import { listCommands } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { hostPaths } from '../../paths.ts'
import { writeTempPackage, FIXTURE_ALPHA } from '../../test/test-helpers-ext.ts'
import { H } from '../../../kernel/index.ts'
import type { Json } from '../../../kernel/index.ts'

describe('term $ref 占位符', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  describe('normalizeRefPath', () => {
    it('规范路径原样；./ 与空段折叠；.. / 空返回 null', () => {
      expect(normalizeRefPath('terms/foo.json')).toBe('terms/foo.json')
      expect(normalizeRefPath('./terms/a.json')).toBe('terms/a.json')
      expect(normalizeRefPath('a//b')).toBe('a/b')
      expect(normalizeRefPath('..')).toBeNull()
      expect(normalizeRefPath('a/../b')).toBeNull()
      expect(normalizeRefPath('')).toBeNull()
    })
  })

  describe('collectRefs', () => {
    it('只收集单一 $ref 保留键的占位符；其余结构原样遍历', () => {
      const out: string[] = []
      collectRefs(['c', { $ref: 'terms/foo.json' }], out)
      expect(out).toEqual(['terms/foo.json'])

      const out2: string[] = []
      collectRefs(
        {
          a: [{ $ref: 'terms/x.json' }],
          b: { $ref: 'terms/y.json' },
          c: 1,
          d: { deep: { $ref: 'terms/z.json' } },
        },
        out2,
      )
      expect(out2).toEqual(['terms/x.json', 'terms/y.json', 'terms/z.json'])
    })
  })

  describe('replaceTermRefs', () => {
    it('占位符替换成哈希；普通对象 / 数组 / 标量不动；resolve 失败 → ok:false', () => {
      const replaced = replaceTermRefs(
        ['seq', { $ref: 'terms/foo.json' }, { x: { $ref: 'terms/bar.json' } }],
        (ref) => (ref === 'terms/foo.json' ? 'hashA' : 'hashB'),
      )
      expect(replaced).toEqual({ ok: true, value: ['seq', 'hashA', { x: 'hashB' }] })

      const fail = replaceTermRefs({ $ref: 'terms/missing.json' }, () => null)
      expect(fail.ok).toBe(false)
    })

    it('含 .. 的引用在替换阶段即失败', () => {
      const fail = replaceTermRefs({ $ref: '../outside.json' }, () => 'h')
      expect(fail.ok).toBe(false)
    })
  })

  describe('termTopoOrder', () => {
    it('线性链：callee 先于 caller', () => {
      const order = termTopoOrder(['terms/a', 'terms/b', 'terms/c'], (p) =>
        p === 'terms/b' ? ['terms/a'] : p === 'terms/c' ? ['terms/b'] : [],
      )
      expect(order).toEqual(['terms/a', 'terms/b', 'terms/c'])
    })

    it('菱形：公共 callee 只算一次依赖', () => {
      const order = termTopoOrder(['terms/a', 'terms/b', 'terms/c', 'terms/d'], (p) =>
        p === 'terms/b'
          ? ['terms/a']
          : p === 'terms/c'
            ? ['terms/a']
            : p === 'terms/d'
              ? ['terms/b', 'terms/c']
              : [],
      )
      expect(order).not.toBeNull()
      const list = order as string[]
      expect(list.indexOf('terms/a')).toBeLessThan(list.indexOf('terms/b'))
      expect(list.indexOf('terms/a')).toBeLessThan(list.indexOf('terms/c'))
      expect(list.indexOf('terms/b')).toBeLessThan(list.indexOf('terms/d'))
      expect(list.indexOf('terms/c')).toBeLessThan(list.indexOf('terms/d'))
    })

    it('成环（含自环）返回 null', () => {
      expect(termTopoOrder(['a', 'b'], (p) => (p === 'a' ? ['b'] : ['a']))).toBeNull()
      expect(termTopoOrder(['a'], () => ['a'])).toBeNull()
    })
  })

  describe('seed 级：替换后哈希与世界 def 一致', () => {
    it('链式 $ref 替换后：world.defs 存在、sig === commitHash、无 pins；listCommands entry 一致', () => {
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-term',
        start: 'node execute/main.js',
        terms: {
          'foo.json': JSON.stringify(['c', 'hello']),
          'bar.json': JSON.stringify(['c', { $ref: 'terms/foo.json' }]),
          'baz.json': JSON.stringify([
            'seq',
            { $ref: 'terms/bar.json' },
            { $ref: 'terms/foo.json' },
          ]),
        },
        commands: [{ name: 'toy.term', entry: 'terms/baz.json' }],
      })
      const report = runSeed(root, [
        { name: 'toy-term', path: pkgRoot },
        { name: 'toy-alpha', path: FIXTURE_ALPHA },
      ])
      expect(report.ok).toBe(true)

      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      const commitHash = world.ids['toy-term'].active as string
      expect(commitHash).toBeTruthy()

      const fooHash = H({ body: ['c', 'hello'], sig: commitHash } as unknown as Json)
      const barHash = H({ body: ['c', fooHash], sig: commitHash } as unknown as Json)
      const bazHash = H({ body: ['seq', barHash, fooHash], sig: commitHash } as unknown as Json)

      expect(world.defs[fooHash]).toBeDefined()
      expect(world.defs[barHash]).toBeDefined()
      expect(world.defs[bazHash]).toBeDefined()

      const barDef = world.defs[barHash] as { body: Json; sig: string; pins?: unknown }
      expect(barDef.sig).toBe(commitHash)
      expect('pins' in barDef).toBe(false)
      expect(barDef.body).toEqual(['c', fooHash])

      const commands = listCommands(world, hostPaths(root).blobsDir)
      const cmd = commands.find((c) => c.name === 'toy.term')
      expect(cmd).toBeDefined()
      expect(cmd!.entry).toBe(bazHash)
      expect(cmd!.identity).toBe('toy-term')
    })
  })

  describe('seed 级：坏引用 / 成环整包拒', () => {
    it('$ref 指向包内不存在的成员 → bad_term_ref，整包拒', () => {
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-badref',
        start: 'node execute/main.js',
        terms: {
          'foo.json': JSON.stringify(['c', { $ref: 'terms/missing.json' }]),
        },
        commands: [{ name: 'toy.badref', entry: 'terms/foo.json' }],
      })
      const report = runSeed(root, [{ name: 'toy-badref', path: pkgRoot }])
      expect(report.ok).toBe(false)
      expect(report.items[0].reasons).toEqual(['bad_term_ref'])
      expect(report.items[0].status).toBe('failed')
    })

    it('$ref 含 ..（包外引用）→ bad_term_ref', () => {
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-badref2',
        start: 'node execute/main.js',
        terms: {
          'foo.json': JSON.stringify(['c', { $ref: '../outside.json' }]),
        },
        commands: [{ name: 'toy.badref2', entry: 'terms/foo.json' }],
      })
      const report = runSeed(root, [{ name: 'toy-badref2', path: pkgRoot }])
      expect(report.items[0].reasons).toEqual(['bad_term_ref'])
    })

    it('term_cycle 整包拒，其他包照常 seed', () => {
      const cycRoot = writeTempPackage(root, {
        identity: 'toy-termcyc',
        start: 'node execute/main.js',
        terms: {
          'a.json': JSON.stringify(['c', { $ref: 'terms/b.json' }]),
          'b.json': JSON.stringify(['c', { $ref: 'terms/a.json' }]),
        },
        commands: [{ name: 'toy.cyc', entry: 'terms/a.json' }],
      })
      const report = runSeed(root, [
        { name: 'toy-termcyc', path: cycRoot },
        { name: 'toy-alpha', path: FIXTURE_ALPHA },
      ])
      const cyc = report.items.find((i) => i.name === 'toy-termcyc')
      const alpha = report.items.find((i) => i.name === 'toy-alpha')
      expect(cyc!.status).toBe('failed')
      expect(cyc!.reasons).toEqual(['term_cycle'])
      expect(alpha!.status).toBe('seeded')

      const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
      expect(world.ids['toy-termcyc']).toBeUndefined()
      expect(world.ids['toy-alpha']).toBeDefined()
    })
  })
})
