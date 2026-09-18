import { describe, expect, it } from 'vitest'
import {
  parsePluginDecl,
  readPluginDecl,
  resolveTreeBlob,
  listCommands,
  resolveCommand,
  termDefOf,
} from '../index.ts'

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
  })
})
