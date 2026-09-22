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
  it('合法 decl（build 省略）且 state=recomputable、member kind 合法 → ok:true', () => {
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

  it('build 省略 → ok:true 且 build 为 null（回落旧探测）', () => {
    const result = parsePluginDecl(baseDecl())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.build).toBeNull()
  })

  it('build 合法 → ok:true 且解析出步骤', () => {
    const result = parsePluginDecl(
      baseDecl({ build: [{ cmd: 'cargo', args: ['build', '--release'] }] }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.build).toEqual([{ cmd: 'cargo', args: ['build', '--release'] }])
    }
  })

  it('build 空数组 → ok:true 且 build 为 []（显式无需构建）', () => {
    const result = parsePluginDecl(baseDecl({ build: [] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.build).toEqual([])
  })

  it('build 非数组 / 项非对象 / 缺 cmd / args 非字符串数组 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ build: 'cargo' })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ build: [1] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ build: [{ args: ['build'] }] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ build: [{ cmd: 'cargo' }] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ build: [{ cmd: 'cargo', args: 'build' }] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ build: [{ cmd: 'cargo', args: [1] }] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ build: [{ cmd: '', args: [] }] })).ok).toBe(false)
  })

  it('build 令牌含 shell 元字符 / 空白 / 引号 → ok:false（注入面入世掐断）', () => {
    for (const bad of [
      'build;rm -rf /',
      'build && evil',
      'build | evil',
      '$(evil)',
      '`evil`',
      'a b',
      '--flag="x"',
      "a'b",
      'a\\b',
      'a\nb',
      'a\0b',
      '*',
      '?',
      '~',
      '#',
    ]) {
      expect(
        parsePluginDecl(baseDecl({ build: [{ cmd: 'cargo', args: [bad] }] })).ok,
        `参数 ${JSON.stringify(bad)} 应被拒`,
      ).toBe(false)
      expect(
        parsePluginDecl(baseDecl({ build: [{ cmd: bad, args: [] }] })).ok,
        `命令 ${JSON.stringify(bad)} 应被拒`,
      ).toBe(false)
    }
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
