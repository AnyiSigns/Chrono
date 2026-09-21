import { describe, expect, it } from 'vitest'
import { parsePluginDecl } from '../index.ts'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function baseDecl(overrides: Record<string, Json> = {}): Json {
  return {
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
    ...overrides,
  }
}

describe('parsePluginDecl 元 schema 严格性', () => {
  it('合法 12 字段 decl 且 state=recomputable、member kind 合法 → ok:true', () => {
    const result = parsePluginDecl(baseDecl())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.identity).toBe('toy')
      expect(result.decl.implements).toEqual(['toy.echo'])
      expect(result.decl.members).toHaveLength(1)
      expect(result.decl.members[0].kind).toBe('term')
      expect(result.decl.commands).toHaveLength(1)
      expect(result.decl.commands[0].name).toBe('toy.hello')
    }
  })

  it('空 members / 空 commands 仍可通过', () => {
    const result = parsePluginDecl(baseDecl({ members: [], commands: [] }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.members).toEqual([])
      expect(result.decl.commands).toEqual([])
    }
  })

  it('schema 省略 / 空串 → ok:true 且 schema 为 null（零 schema 合法）', () => {
    const omitted = baseDecl()
    delete (omitted as Record<string, Json>)['schema']
    const withoutSchema = parsePluginDecl(omitted)
    expect(withoutSchema.ok).toBe(true)
    if (withoutSchema.ok) expect(withoutSchema.decl.schema).toBeNull()

    const emptySchema = parsePluginDecl(baseDecl({ schema: '' }))
    expect(emptySchema.ok).toBe(true)
    if (emptySchema.ok) expect(emptySchema.decl.schema).toBeNull()
  })

  it('schema 显式 null / 非字符串 → ok:false（省略才是唯一写法）', () => {
    expect(parsePluginDecl(baseDecl({ schema: null })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ schema: 1 })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ schema: {} })).ok).toBe(false)
  })

  it('state 非 recomputable（如 durable）→ ok:false', () => {
    expect(parsePluginDecl(baseDecl({ state: 'durable' })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ state: 'ephemeral' })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ state: '' })).ok).toBe(false)
  })

  it('member kind 非法（如 binary）→ ok:false', () => {
    expect(parsePluginDecl(baseDecl({ members: [{ kind: 'binary', path: 'bin/' }] })).ok).toBe(
      false,
    )
  })

  it('缺失 identity → ok:false（回归）', () => {
    expect(parsePluginDecl(baseDecl({ identity: '' })).ok).toBe(false)
  })

  it('commands 缺 name / entry → ok:false（回归）', () => {
    expect(
      parsePluginDecl(
        baseDecl({
          commands: [{ name: '', entry: '' }],
        }),
      ).ok,
    ).toBe(false)
  })

  it('commands 缺 entry 字段 → ok:false（回归）', () => {
    expect(
      parsePluginDecl(
        baseDecl({
          commands: [{ name: 'cmd' }],
        }),
      ).ok,
    ).toBe(false)
  })

  it('顶层非对象 → ok:false', () => {
    expect(parsePluginDecl(null as unknown as Json).ok).toBe(false)
    expect(parsePluginDecl('string' as unknown as Json).ok).toBe(false)
    expect(parsePluginDecl([] as unknown as Json).ok).toBe(false)
  })
})
