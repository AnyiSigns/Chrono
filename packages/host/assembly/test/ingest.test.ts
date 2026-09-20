import { describe, expect, it } from 'vitest'
import {
  parsePluginDecl,
  readPluginDecl,
  resolveTreeBlob,
  listCommands,
  resolveCommand,
  termDefOf,
} from '../index.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

describe('装配 assembly', () => {
  describe('parsePluginDecl', () => {
    it('合法 plugin.json 解析通过，字段齐全', () => {
      const decl = {
        identity: 'toy',
        schema: 'schema/x.json',
        implements: ['toy.echo'],
        methods: { 'toy.echo': ['echo'] },
        pins: {},
        start: '',
        protocol: '1',
        restart: { policy: 'on-exit' },
        health: { probe: 'p' },
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

  describe('seed 级：保留 pin host', () => {
    it("pins 值为 'host'：解析为保留字面量，不报 unresolved_pin", async () => {
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
        const pins = identity!.gens[identity!.gens.length - 1].pins
        expect(pins['host']).toBe('host')
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
        const commands = listCommands(world)
        const dot = commands.find((c) => c.name === 'toy.dot')
        const mid = commands.find((c) => c.name === 'toy.mid')
        expect(dot).toBeDefined()
        expect(mid).toBeDefined()
        // 两种写法规范化后指向同一 term def
        expect(dot!.entry).toBe(mid!.entry)
        expect(resolveCommand(world, 'toy.dot')).not.toBeNull()
        expect(resolveCommand(world, 'toy.mid')).not.toBeNull()
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })
})
