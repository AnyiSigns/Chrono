import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isIgnored, packSourceDir, parseWorldignoreText, pathSegments } from '../source.ts'
import { planIngest } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { readJournal } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { applyBatchOps, collectTreePaths, writeTempPackage } from '../../test/test-helpers-ext.ts'
import { hostPaths } from '../../paths.ts'
import type { World } from '../../../kernel/index.ts'

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

function writeTree(abs: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(abs, rel)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}

describe('入世排除 .worldignore', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  describe('pathSegments / parseWorldignoreText', () => {
    it('相对路径拆成路径段；空段与 . 丢弃；.. 视为非法', () => {
      expect(pathSegments('test')).toEqual(['test'])
      expect(pathSegments('./dist')).toEqual(['dist'])
      expect(pathSegments('a/./b/')).toEqual(['a', 'b'])
      expect(pathSegments('..')).toBeNull()
      expect(pathSegments('a/../b')).toBeNull()
      expect(pathSegments('')).toEqual([])
    })

    it('# 注释与空行忽略，其余每行一个模式', () => {
      const read = parseWorldignoreText('# 注释\n\ntest/\ndist\n')
      expect(read.ok).toBe(true)
      if (read.ok) {
        expect(read.patterns).toEqual([['test'], ['dist']])
      }
    })

    it('非法模式（含 ..）→ ok:false', () => {
      expect(parseWorldignoreText('ok/\n../outside\n').ok).toBe(false)
    })
  })

  describe('isIgnored 路径段前缀匹配', () => {
    it('模式 test 命中 test 与 test/x，不命中 test.js', () => {
      const patterns = [['test']]
      expect(isIgnored(['test'], patterns)).toBe(true)
      expect(isIgnored(['test', 'x', 'y'], patterns)).toBe(true)
      expect(isIgnored(['test.js'], patterns)).toBe(false)
      expect(isIgnored(['mytest'], patterns)).toBe(false)
    })

    it('深层模式只命中同前缀路径', () => {
      const patterns = [['sub', 'inner']]
      expect(isIgnored(['sub', 'inner', 'file.txt'], patterns)).toBe(true)
      expect(isIgnored(['sub'], patterns)).toBe(false)
      expect(isIgnored(['sub', 'other'], patterns)).toBe(false)
    })
  })

  describe('packSourceDir 打包排除', () => {
    function buildPkgDir(): string {
      const pkgRoot = join(root, 'pkg-x')
      writeTree(pkgRoot, {
        'plugin.json': '{"identity":"x"}',
        'package.json': '{}',
        'README.md': '# x\n',
        'dist/bundle.js': 'bundle',
        'test/spec.js': 'spec',
        'test/nested/deep.js': 'deep',
        'test.js': 'root test.js',
        '.git/config': '[core]',
        'node_modules/dep/index.js': 'dep',
        '.worldignore': 'ignored by host\n',
        'execute/main.js': 'main',
        'sub/inner/file.txt': 'inner',
      })
      return pkgRoot
    }

    it('默认排除 node_modules / .git / .worldignore；dist 与 test.js 默认进树', () => {
      const pkgRoot = buildPkgDir()
      const packed = packSourceDir(pkgRoot, [])
      const world = emptyWorld()
      applyBatchOps(world, packed.ops)
      const paths = collectTreePaths(world, packed.rootTreeHash)
      expect(paths).not.toContain('node_modules/dep/index.js')
      expect(paths).not.toContain('.git/config')
      expect(paths).not.toContain('.worldignore')
      expect(paths).toContain('dist/bundle.js')
      expect(paths).toContain('test.js')
      expect(paths).toContain('test/spec.js')
      expect(paths).toContain('plugin.json')
      expect(paths).toContain('execute/main.js')
      expect(paths).toContain('sub/inner/file.txt')
      expect(packed.fileCount).toBeGreaterThan(0)
    })

    it('模式 test 排除 test/ 整支，不误伤根级 test.js', () => {
      const pkgRoot = buildPkgDir()
      const packed = packSourceDir(pkgRoot, [['test']])
      const world = emptyWorld()
      applyBatchOps(world, packed.ops)
      const paths = collectTreePaths(world, packed.rootTreeHash)
      expect(paths).not.toContain('test/spec.js')
      expect(paths).not.toContain('test/nested/deep.js')
      expect(paths).toContain('test.js')
      expect(paths).toContain('dist/bundle.js')
    })

    it('模式 dist 排除 dist 目录', () => {
      const pkgRoot = buildPkgDir()
      const packed = packSourceDir(pkgRoot, [['dist']])
      const world = emptyWorld()
      applyBatchOps(world, packed.ops)
      const paths = collectTreePaths(world, packed.rootTreeHash)
      expect(paths).not.toContain('dist/bundle.js')
    })

    it('深层模式 sub/inner 排除嵌套目录内文件', () => {
      const pkgRoot = buildPkgDir()
      const packed = packSourceDir(pkgRoot, [['sub', 'inner']])
      const world = emptyWorld()
      applyBatchOps(world, packed.ops)
      const paths = collectTreePaths(world, packed.rootTreeHash)
      expect(paths).not.toContain('sub/inner/file.txt')
      expect(paths).toContain('test/spec.js')
    })
  })

  describe('planIngest / runSeed 契约必需文件保护', () => {
    it('worldignore 命中 plugin.json → bad_worldignore 且不写 batch', () => {
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-ign',
        worldignore: ['plugin.json'],
        start: 'node execute/main.js',
      })
      const planned = planIngest(emptyWorld(), root, { name: 'toy-ign', path: pkgRoot })
      expect(planned.ok).toBe(false)
      if (!planned.ok) expect(planned.reasons).toEqual(['bad_worldignore'])

      const report = runSeed(root, [{ name: 'toy-ign', path: pkgRoot }])
      expect(report.ok).toBe(false)
      expect(report.items[0].status).toBe('failed')
      expect(report.items[0].reasons).toEqual(['bad_worldignore'])
      const journalFile = hostPaths(root).journalFile
      expect(readJournal(journalFile)).toEqual([])
    })

    it('worldignore 命中 README.md / schema / members 路径 → bad_worldignore', () => {
      const cases: string[][] = [['README.md'], ['schema'], ['execute']]
      for (const pattern of cases) {
        const pkgRoot = writeTempPackage(root, {
          identity: 'toy-ign2',
          worldignore: pattern,
          start: 'node execute/main.js',
        })
        const planned = planIngest(emptyWorld(), root, { name: 'toy-ign2', path: pkgRoot })
        expect(planned.ok).toBe(false)
        if (!planned.ok) expect(planned.reasons).toEqual(['bad_worldignore'])
      }
    })

    it('worldignore 命中的非必需文件被排除，其余正常 → seed 成功', () => {
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-ok',
        worldignore: ['dist'],
        start: 'node execute/main.js',
        files: { 'dist/bundle.js': 'bundle', 'src/keep.js': 'keep' },
      })
      const report = runSeed(root, [{ name: 'toy-ok', path: pkgRoot }])
      expect(report.ok).toBe(true)
      expect(report.items[0].status).toBe('seeded')
    })

    it('非法模式（..）→ bad_worldignore，其余包照常', () => {
      const badRoot = writeTempPackage(root, {
        identity: 'toy-badign',
        worldignore: ['../outside'],
        start: 'node execute/main.js',
      })
      const goodRoot = writeTempPackage(root, {
        identity: 'toy-good',
        start: 'node execute/main.js',
      })
      const report = runSeed(root, [
        { name: 'toy-badign', path: badRoot },
        { name: 'toy-good', path: goodRoot },
      ])
      const bad = report.items.find((i) => i.name === 'toy-badign')
      const good = report.items.find((i) => i.name === 'toy-good')
      expect(bad!.status).toBe('failed')
      expect(bad!.reasons).toEqual(['bad_worldignore'])
      expect(good!.status).toBe('seeded')
    })

    it('bun.lock 存在且被 worldignore 命中 → bad_worldignore（锁文件属契约必需）', () => {
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-bunlock',
        worldignore: ['bun.lock'],
        start: 'node execute/main.js',
        files: { 'bun.lock': '{}' },
      })
      const planned = planIngest(emptyWorld(), root, { name: 'toy-bunlock', path: pkgRoot })
      expect(planned.ok).toBe(false)
      if (!planned.ok) expect(planned.reasons).toEqual(['bad_worldignore'])

      const report = runSeed(root, [{ name: 'toy-bunlock', path: pkgRoot }])
      expect(report.items[0].status).toBe('failed')
      expect(report.items[0].reasons).toEqual(['bad_worldignore'])
    })
  })
})
