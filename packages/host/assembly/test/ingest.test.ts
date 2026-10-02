import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parsePluginDecl,
  readPluginDecl,
  readPluginManifest,
  resolveTreeBlob,
  listCommands,
  resolveCommand,
  termDefOf,
  planIngest,
} from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeChronoConfig, writeTempPackage } from '../../test/test-helpers-ext.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

describe('装配 assembly', () => {
  describe('parsePluginDecl', () => {
    it('合法 plugin.json 解析通过，字段齐全', () => {
      const decl = {
        identity: 'toy',
        schema: 'schema/x.json',
        implements: ['toy.echo'],
        methods: { 'toy.echo': ['echo'] },
        start: '',
        build: [],
        protocol: '1',
        restart: { policy: 'on-exit' },
        health: {},
        state: 'recomputable',
        members: [{ kind: 'term', path: 'terms/' }],
        commands: [{ name: 'toy.hello', entry: 'terms/hello.json' }],
      }
      const result = parsePluginDecl(decl as Json)
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.decl.identity).toBe('toy')
        expect(result.decl.implements).toEqual(['toy.echo'])
        expect(result.decl.commands).toHaveLength(1)
        expect(result.decl.commands[0].name).toBe('toy.hello')
      }
    })

    it('缺 identity / implements 非数组 → bad_plugin_decl', () => {
      expect(parsePluginDecl({ identity: '', implements: 'x' } as Json).ok).toBe(false)
      expect(parsePluginDecl({ identity: 't', implements: [] } as Json).ok).toBe(false)
    })

    it('commands 缺 name / entry → bad_plugin_decl', () => {
      const result = parsePluginDecl({
        identity: 't',
        schema: 's',
        implements: [],
        methods: {},
        pins: {},
        start: '',
        protocol: '1',
        restart: {},
        health: {},
        state: 'recomputable',
        members: [],
        commands: [{ name: '', entry: '' }],
      } as Json)
      expect(result.ok).toBe(false)
    })

    it('保留命令名（宿主命令 start/stop/run/status/seed/verify/replay）→ bad_plugin_decl', () => {
      for (const name of ['start', 'stop', 'run', 'status', 'seed', 'verify', 'replay']) {
        const result = parsePluginDecl({
          identity: 't',
          schema: 's',
          implements: [],
          methods: {},
          pins: {},
          start: '',
          protocol: '1',
          restart: {},
          health: {},
          state: 'recomputable',
          members: [],
          commands: [{ name, entry: 'terms/x.json' }],
        } as Json)
        expect(result.ok, `命令名 ${name} 应被拒`).toBe(false)
      }
    })
  })

  describe('termDefOf', () => {
    it('返回 body + sig，不改动输入', () => {
      const ast = ['c', 'hello']
      const sig = 'sig'.repeat(64)
      const def = termDefOf(ast, sig)
      expect(def.body).toBe(ast)
      expect(def.sig).toBe(sig)
    })
  })

  describe('resolveTreeBlob', () => {
    it('沿 tree 读取文件文本，路径不存在返回 null', () => {
      const th = 'th'.repeat(32)
      const ph = 'ph'.repeat(32)
      const world = {
        defs: {
          [th]: { body: { entries: [{ name: 'plugin.json', mode: 'file', hash: ph }] } },
          [ph]: { body: 'hello world' },
        },
        ids: {},
      }
      expect(resolveTreeBlob(world, th, 'plugin.json')).toBe('hello world')
      expect(resolveTreeBlob(world, th, 'missing.json')).toBeNull()
      expect(resolveTreeBlob(world, 'ghost'.repeat(16), 'anything')).toBeNull()
    })

    it("'.' 段与空段同口径折叠：'./plugin.json' / 'dir/./b' 解析到规范路径", () => {
      const th = 'th'.repeat(32)
      const ah = 'ah'.repeat(32)
      const bh = 'bh'.repeat(32)
      const world = {
        defs: {
          [th]: {
            body: {
              entries: [
                { name: 'plugin.json', mode: 'file', hash: bh },
                { name: 'dir', mode: 'dir', hash: ah },
              ],
            },
          },
          [ah]: { body: { entries: [{ name: 'b', mode: 'file', hash: bh }] } },
          [bh]: { body: 'hello world' },
        },
        ids: {},
      }
      expect(resolveTreeBlob(world, th, './plugin.json')).toBe('hello world')
      expect(resolveTreeBlob(world, th, 'dir/./b')).toBe('hello world')
      expect(resolveTreeBlob(world, th, 'dir//b')).toBe('hello world')
      expect(resolveTreeBlob(world, th, './dir/./b')).toBe('hello world')
    })
  })

  describe('seed 级：build 声明门禁', () => {
    it('build 令牌含 shell 元字符 → 整包拒 bad_plugin_decl', async () => {
      const root = createTempRoot()
      try {
        const pkgRoot = writeTempPackage(root, {
          identity: 'toy-badbuild',
          omitSchema: true,
          start: '',
          members: [{ kind: 'term', path: 'terms/' }],
          terms: { 'x.json': JSON.stringify(['c', 1]) },
          files: {
            'plugin.json': JSON.stringify({
              identity: 'toy-badbuild',
              implements: [],
              methods: {},
              pins: {},
              start: '',
              build: [{ cmd: 'cargo', args: ['build; rm -rf /'] }],
              protocol: '1',
              restart: {},
              health: {},
              state: 'recomputable',
              members: [{ kind: 'term', path: 'terms/' }],
              commands: [],
            }),
          },
        })
        const report = runSeed(root, [{ name: 'toy-badbuild', path: pkgRoot }])
        expect(report.ok).toBe(false)
        expect(report.items[0].status).toBe('failed')
        expect(report.items[0].reasons).toContain('bad_plugin_decl')
        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
        expect(Object.hasOwn(world.ids, 'toy-badbuild')).toBe(false)
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })

  describe('seed 级：宿主依赖哨兵 host', () => {
    it("needs.host：解析为宿主哨兵，不报 unresolved_need", async () => {
      const root = createTempRoot()
      try {
        const pkgRoot = writeTempPackage(root, {
          identity: 'toy-hostpin',
          pins: { host: 'host' },
          start: '',
          members: [{ kind: 'term', path: 'terms/' }],
          terms: { 'x.json': JSON.stringify(['c', 1]) },
        })
        const report = runSeed(root, [{ name: 'toy-hostpin', path: pkgRoot }])
        expect(report.ok).toBe(true)
        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
        const identity = world.ids['toy-hostpin']
        expect(identity).toBeDefined()
        const gen = identity!.gens[identity!.gens.length - 1]
        const body = world.defs[gen.payload].body as { meta?: { needs?: Record<string, string> } }
        expect(body.meta?.needs?.['host']).toBe('host')
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })

  describe('seed 级：身份名安全单段净化', () => {
    const cases: Array<[string, string]> = [
      ['a/b', 'slash'],
      ['../x', 'dotdot'],
      ['C:\\x', 'drive'],
      ['host', 'reserved-host'],
      ['__proto__', 'proto-key'],
      ['CON', 'windows-reserved'],
      ['x.', 'trailing-dot'],
      ['x:y', 'colon'],
    ]
    for (const [identity, dir] of cases) {
      it(`identity=${JSON.stringify(identity)} → 整包拒 bad_plugin_decl`, async () => {
        const root = createTempRoot()
        try {
          const pkgRoot = writeTempPackage(root, {
            identity,
            dir,
            start: '',
            members: [{ kind: 'term', path: 'terms/' }],
            terms: { 'x.json': JSON.stringify(['c', 1]) },
          })
          const report = runSeed(root, [{ name: identity, path: pkgRoot }])
          expect(report.ok).toBe(false)
          expect(report.items[0].status).toBe('failed')
          expect(report.items[0].reasons).toContain('bad_plugin_decl')
          // 世界分文未动：不安全身份名不得成为目录 / 身份（用 hasOwn 防原型键误判）
          const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
          expect(Object.hasOwn(world.ids, identity)).toBe(false)
        } finally {
          await cleanupTempRoot(root)
        }
      })
    }
  })

  describe('seed 级：受保护 pins（运营配置）', () => {
    it('受保护身份被删 pin → 拒 protected_pin_removed；未受保护身份被删 → 放行', async () => {
      const root = createTempRoot()
      try {
        writeChronoConfig(root, ['sandbox'])
        const sandboxRoot = writeTempPackage(root, { identity: 'sandbox', implements: ['sandbox'] })
        const otherRoot = writeTempPackage(root, { identity: 'other-dep', implements: ['other'] })
        const guardedRoot = writeTempPackage(root, {
          identity: 'tool-guarded',
          pins: { sandbox: 'sandbox' },
        })
        const freeRoot = writeTempPackage(root, {
          identity: 'tool-free',
          pins: { other: 'other-dep' },
        })
        const report = runSeed(root, [
          { name: 'sandbox', path: sandboxRoot },
          { name: 'other-dep', path: otherRoot },
          { name: 'tool-guarded', path: guardedRoot },
          { name: 'tool-free', path: freeRoot },
        ])
        expect(report.ok).toBe(true)
        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world

        // 受保护：删掉 sandbox 引用 → 拒
        writeTempPackage(root, { identity: 'tool-guarded', pins: {} })
        const guarded = planIngest(world, root, { name: 'tool-guarded', path: guardedRoot })
        expect(guarded.ok).toBe(false)
        if (!guarded.ok) expect(guarded.reasons).toEqual(['protected_pin_removed'])

        // 未受保护：删掉对同一身份的别名 pin → 放行
        writeTempPackage(root, { identity: 'tool-free', pins: {} })
        const free = planIngest(world, root, { name: 'tool-free', path: freeRoot })
        expect(free.ok).toBe(true)
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })

  describe('seed 级：命令入口路径规范化', () => {
    it("入口含 './' 段：seed 成功且 listCommands / resolveCommand 命中", async () => {
      const root = createTempRoot()
      try {
        const pkgRoot = writeTempPackage(root, {
          identity: 'toy-dotentry',
          start: 'node execute/main.js',
          terms: { 'plain.json': JSON.stringify(['c', 'hello']) },
          commands: [
            { name: 'toy.dot', entry: './terms/plain.json' },
            { name: 'toy.mid', entry: 'terms/./plain.json' },
          ],
        })
        const report = runSeed(root, [{ name: 'toy-dotentry', path: pkgRoot }])
        expect(report.ok).toBe(true)

        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
        const commands = listCommands(world, hostPaths(root).blobsDir)
        const dot = commands.find((c) => c.name === 'toy.dot')
        const mid = commands.find((c) => c.name === 'toy.mid')
        expect(dot).toBeDefined()
        expect(mid).toBeDefined()
        // 两种写法规范化后指向同一 term def
        expect(dot!.entry).toBe(mid!.entry)
        expect(resolveCommand(world, 'toy.dot', hostPaths(root).blobsDir)).not.toBeNull()
        expect(resolveCommand(world, 'toy.mid', hostPaths(root).blobsDir)).not.toBeNull()
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })

  describe('state/plugins.json 清单读面', () => {
    function writeManifest(root: string, body: string): void {
      writeFileSync(join(root, 'state', 'plugins.json'), body)
    }

    it('缺文件 → 空表', () => {
      const root = createTempRoot()
      expect(readPluginManifest(root)).toEqual([])
    })

    it('合法清单 → 逐项解析（path 为字符串原样保留）', () => {
      const root = createTempRoot()
      writeManifest(
        root,
        JSON.stringify([
          { name: 'toy', path: 'pkgs/toy' },
          { name: 'excluded', exclude: true },
        ]),
      )
      const entries = readPluginManifest(root)
      expect(entries).toContainEqual({ name: 'toy', path: 'pkgs/toy' })
      expect(entries.some((entry) => entry.name === 'excluded')).toBe(false)
    })

    it('非法 JSON → 抛 bad_plugins_manifest（不泄漏 SyntaxError）', () => {
      const root = createTempRoot()
      writeManifest(root, '{ not json')
      expect(() => readPluginManifest(root)).toThrow('bad_plugins_manifest')
    })

    it('形状非法：顶层非数组 / 项非对象 / 缺 name / path 非字符串 / exclude 非布尔 → 抛 bad_plugins_manifest', () => {
      const cases = [
        '{}',
        '[1]',
        '[{}]',
        '[{"name":""}]',
        '[{"name":"toy","path":123}]',
        '[{"name":"toy","exclude":"yes"}]',
      ]
      for (const body of cases) {
        const root = createTempRoot()
        writeManifest(root, body)
        expect(() => readPluginManifest(root), `body=${body} 应被拒`).toThrow(
          'bad_plugins_manifest',
        )
      }
    })

    it('runSeed 与 watcher 同口径：坏清单同样归 bad_plugins_manifest（非 SyntaxError）', () => {
      const root = createTempRoot()
      writeManifest(root, '{ not json')
      expect(() => runSeed(root)).toThrow('bad_plugins_manifest')
    })
  })
})
