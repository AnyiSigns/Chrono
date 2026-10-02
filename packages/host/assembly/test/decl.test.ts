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
    build: [],
    protocol: '1',
    restart: { policy: 'on-exit' },
    health: {},
    state: 'recomputable',
    members: [{ kind: 'term', path: 'terms/' }],
    commands: [{ name: 'toy.hello', entry: 'terms/hello.json' }],
    ...overrides,
  }
}

describe('parsePluginDecl 元 schema 严格性', () => {
  it('合法 decl 且 state=recomputable、member kind 合法 → ok:true', () => {
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

  it('build 省略 → ok:false（build 是必需声明，宿主不再回落探测）', () => {
    const omitted = baseDecl()
    delete (omitted as Record<string, Json>)['build']
    const result = parsePluginDecl(omitted)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reasons).toEqual(['bad_plugin_decl'])
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

  it('exclusive 省略 → ok:true 且 exclusive 为 []（无独占资源）', () => {
    const result = parsePluginDecl(baseDecl())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.exclusive).toEqual([])
  })

  it('exclusive 合法（port）→ ok:true 且解析出资源类', () => {
    const result = parsePluginDecl(baseDecl({ exclusive: ['port'] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.exclusive).toEqual(['port'])
  })

  it('exclusive 空数组 → ok:true 且 exclusive 为 []（显式无独占资源）', () => {
    const result = parsePluginDecl(baseDecl({ exclusive: [] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.exclusive).toEqual([])
  })

  it('exclusive 资源类名开放：任意非空字符串通过（含 gpu / lock）', () => {
    const gpu = parsePluginDecl(baseDecl({ exclusive: ['gpu'] }))
    expect(gpu.ok).toBe(true)
    if (gpu.ok) expect(gpu.decl.exclusive).toEqual(['gpu'])
    const mixed = parsePluginDecl(baseDecl({ exclusive: ['port', 'gpu'] }))
    expect(mixed.ok).toBe(true)
    if (mixed.ok) expect(mixed.decl.exclusive).toEqual(['port', 'gpu'])
    expect(parsePluginDecl(baseDecl({ exclusive: ['lock', 'singleton'] })).ok).toBe(true)
  })

  it('exclusive 非数组 / 项非字符串 / 空串 / 原型键 / 超长 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ exclusive: 'port' })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ exclusive: null })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ exclusive: [1] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ exclusive: [''] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ exclusive: ['__proto__'] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ exclusive: ['constructor'] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ exclusive: ['x'.repeat(65)] })).ok).toBe(false)
  })

  it('state 两档：recomputable / durable 通过，其余拒', () => {
    expect(parsePluginDecl(baseDecl({ state: 'recomputable' })).ok).toBe(true)
    expect(parsePluginDecl(baseDecl({ state: 'durable' })).ok).toBe(true)
    expect(parsePluginDecl(baseDecl({ state: 'ephemeral' })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ state: '' })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ state: 'weird' })).ok).toBe(false)
  })

  it("exclusive:['data'] + durable → ok:true 且解析出资源类", () => {
    const result = parsePluginDecl(baseDecl({ exclusive: ['data'], state: 'durable' }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.exclusive).toEqual(['data'])
      expect(result.decl.state).toBe('durable')
    }
  })

  it("exclusive:['data'] + recomputable（含缺省）→ ok:false（声明自相矛盾）", () => {
    expect(parsePluginDecl(baseDecl({ exclusive: ['data'], state: 'recomputable' })).ok).toBe(false)
    // 缺省 state = recomputable，同样拒
    expect(parsePluginDecl(baseDecl({ exclusive: ['data'] })).ok).toBe(false)
  })

  it('exclusive 含 data 与其它资源类 + durable → ok:true（data 交叉校验只认 data 项）', () => {
    const result = parsePluginDecl(baseDecl({ exclusive: ['data', 'gpu'], state: 'durable' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.exclusive).toEqual(['data', 'gpu'])
  })

  it('保留命令名（commands / unseeded / help）→ reserved_command_name', () => {
    for (const name of ['commands', 'unseeded', 'help']) {
      const result = parsePluginDecl(baseDecl({ commands: [{ name, entry: 'terms/hello.json' }] }))
      expect(result.ok, `命令名 ${name} 应被拒`).toBe(false)
      if (!result.ok) expect(result.reasons).toEqual(['reserved_command_name'])
    }
  })

  it('非保留命令名仍通过；空命令名仍归 bad_plugin_decl', () => {
    expect(
      parsePluginDecl(baseDecl({ commands: [{ name: 'toy.ok', entry: 'terms/hello.json' }] })).ok,
    ).toBe(true)
    const empty = parsePluginDecl(baseDecl({ commands: [{ name: '', entry: 'terms/hello.json' }] }))
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reasons).toEqual(['bad_plugin_decl'])
  })

  it('member kind 非法（如 binary）→ ok:false', () => {
    expect(parsePluginDecl(baseDecl({ members: [{ kind: 'binary', path: 'bin/' }] })).ok).toBe(
      false,
    )
  })

  it('缺失 identity → ok:false（回归）', () => {
    expect(parsePluginDecl(baseDecl({ identity: '' })).ok).toBe(false)
  })

  it('身份名不得为保留能力类 host → ok:false（host 不是真实身份）', () => {
    expect(parsePluginDecl(baseDecl({ identity: 'host' })).ok).toBe(false)
  })

  it('commands readonly 缺省 → false（只读是显式声明）', () => {
    const result = parsePluginDecl(baseDecl())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.commands[0].readonly).toBe(false)
  })

  it('commands readonly 显式布尔 → 原样解析', () => {
    const on = parsePluginDecl(
      baseDecl({ commands: [{ name: 'toy.read', entry: 'terms/hello.json', readonly: true }] }),
    )
    expect(on.ok).toBe(true)
    if (on.ok) expect(on.decl.commands[0].readonly).toBe(true)

    const off = parsePluginDecl(
      baseDecl({ commands: [{ name: 'toy.write', entry: 'terms/hello.json', readonly: false }] }),
    )
    expect(off.ok).toBe(true)
    if (off.ok) expect(off.decl.commands[0].readonly).toBe(false)
  })

  it('commands readonly 非布尔（字符串 / null / 数字）→ ok:false（入世拒）', () => {
    for (const bad of ['true', null, 1, 0, {}]) {
      expect(
        parsePluginDecl(
          baseDecl({ commands: [{ name: 'toy.bad', entry: 'terms/hello.json', readonly: bad }] }),
        ).ok,
        `readonly=${JSON.stringify(bad)} 应被拒`,
      ).toBe(false)
    }
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

describe('parsePluginDecl transport 声明', () => {
  it('省略 → 回落 stdio（存量行为不变）', () => {
    const result = parsePluginDecl(baseDecl({ start: 'node execute/main.js' }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.decl.transport).toBe('stdio')
  })

  it('显式 stdio / inproc / worker：同语言入口通过', () => {
    for (const transport of ['stdio', 'inproc', 'worker']) {
      const start = transport === 'stdio' ? 'node execute/main.js' : 'execute/main.js'
      const result = parsePluginDecl(baseDecl({ start, transport }))
      expect(result.ok, `transport=${transport} 应通过`).toBe(true)
      if (result.ok) expect(result.decl.transport).toBe(transport)
    }
  })

  it('inproc / worker 声明非 JS 入口 → ok:false（异语言无法载入同进程 / worker）', () => {
    for (const transport of ['inproc', 'worker']) {
      for (const start of ['python execute/main.py', 'execute/main.py', 'cargo run', '']) {
        expect(
          parsePluginDecl(baseDecl({ start, transport })).ok,
          `transport=${transport} start=${JSON.stringify(start)} 应被拒`,
        ).toBe(false)
      }
    }
  })

  it('inproc / worker 声明逃逸路径 / 含空白入口 → ok:false', () => {
    for (const transport of ['inproc', 'worker']) {
      for (const start of [
        '../escape.mjs',
        '/abs/main.mjs',
        'execute/my main.mjs',
        ' execute/main.mjs',
        'execute/main.mjs ',
        '\texecute/main.mjs',
        'execute/main.mjs\n',
      ]) {
        expect(
          parsePluginDecl(baseDecl({ start, transport })).ok,
          `transport=${transport} start=${JSON.stringify(start)} 应被拒`,
        ).toBe(false)
      }
    }
  })

  it('inproc / worker 首尾空白与消费侧同口径：校验不 trim，运行期原串不会 import_failed', () => {
    // 消费侧 service-host.ts 用 `join(cwd, decl.start)` 原串解析；带空白入口不得通过声明门禁
    for (const transport of ['inproc', 'worker']) {
      const padded = parsePluginDecl(baseDecl({ start: ' execute/main.mjs ', transport }))
      expect(padded.ok).toBe(false)
      const trimmed = parsePluginDecl(baseDecl({ start: 'execute/main.mjs', transport }))
      expect(trimmed.ok).toBe(true)
      if (trimmed.ok) expect(trimmed.decl.start).toBe('execute/main.mjs')
    }
  })

  it('未知 transport 值 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ start: 'execute/main.mjs', transport: 'thread' })).ok).toBe(
      false,
    )
    expect(parsePluginDecl(baseDecl({ start: 'execute/main.mjs', transport: 1 })).ok).toBe(false)
  })
})

describe('parsePluginDecl needs / slots', () => {
  it('两者省略 → 零扰动：仍需 ok，且 needs / slots 为空表', () => {
    const result = parsePluginDecl(baseDecl())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.needs).toEqual({})
      expect(result.decl.slots).toEqual({})
    }
  })

  it('合法 needs（one 无 methods / many 带 methods）解析通过', () => {
    const one = parsePluginDecl(baseDecl({ needs: { 'toy.title': { mode: 'one' } } }))
    expect(one.ok).toBe(true)
    if (one.ok) expect(one.decl.needs).toEqual({ 'toy.title': { mode: 'one' } })

    const many = parsePluginDecl(
      baseDecl({ needs: { 'toy.hook': { mode: 'many', methods: ['onTurn'] } } }),
    )
    expect(many.ok).toBe(true)
    if (many.ok) {
      expect(many.decl.needs).toEqual({ 'toy.hook': { mode: 'many', methods: ['onTurn'] } })
    }
  })

  it('合法 slots（拥有方声明契约）解析通过', () => {
    const result = parsePluginDecl(
      baseDecl({ slots: { 'toy.hook': { methods: ['onTurn', 'onEnd'] } } }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.slots).toEqual({ 'toy.hook': { methods: ['onTurn', 'onEnd'] } })
    }
  })

  it('needs / slots 非对象（数组 / null / 字符串 / 数字）→ ok:false', () => {
    for (const bad of [[], null, 'x', 1]) {
      expect(parsePluginDecl(baseDecl({ needs: bad })).ok, `needs=${JSON.stringify(bad)}`).toBe(
        false,
      )
      expect(parsePluginDecl(baseDecl({ slots: bad })).ok, `slots=${JSON.stringify(bad)}`).toBe(
        false,
      )
    }
  })

  it('needs / slots 条目非对象 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': 'one' } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': null } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ slots: { 'toy.cap': ['m'] } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ slots: { 'toy.cap': 1 } })).ok).toBe(false)
  })

  it('needs / slots 条目未知字段 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'one', extra: 1 } } })).ok).toBe(
      false,
    )
    expect(
      parsePluginDecl(baseDecl({ slots: { 'toy.cap': { methods: ['m'], extra: 1 } } })).ok,
    ).toBe(false)
  })

  it('键为空 / 原型键 → ok:false；needs 保留 host 作宿主哨兵 → ok:true；slots 保留 host → ok:false', () => {
    for (const cap of ['', '__proto__', 'constructor', 'prototype']) {
      expect(
        parsePluginDecl(baseDecl({ needs: { [cap]: { mode: 'one' } } })).ok,
        `needs 键 ${cap}`,
      ).toBe(false)
      expect(
        parsePluginDecl(baseDecl({ slots: { [cap]: { methods: ['m'] } } })).ok,
        `slots 键 ${cap}`,
      ).toBe(false)
    }
    expect(parsePluginDecl(baseDecl({ needs: { host: { mode: 'one' } } })).ok).toBe(true)
    expect(parsePluginDecl(baseDecl({ slots: { host: { methods: ['m'] } } })).ok).toBe(false)
  })

  it('needs 键与 implements / methods 键冲突 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.echo': { mode: 'one' } } })).ok).toBe(false)
    expect(
      parsePluginDecl(
        baseDecl({ methods: { 'toy.extra': ['m'] }, needs: { 'toy.extra': { mode: 'one' } } }),
      ).ok,
    ).toBe(false)
  })

  it('host 哨兵 mode 必须是 one → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ needs: { host: { mode: 'many' } } })).ok).toBe(false)
  })

  it('mode 缺省 / 非 one|many → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': {} } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'some' } } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: '' } } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 1 } } })).ok).toBe(false)
  })

  it('needs.methods 给定时须非空、全字符串、无重复', () => {
    expect(
      parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'many', methods: [] } } })).ok,
    ).toBe(false)
    expect(
      parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'many', methods: ['a', 1] } } })).ok,
    ).toBe(false)
    expect(
      parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'many', methods: ['a', 'a'] } } })).ok,
    ).toBe(false)
    expect(
      parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'many', methods: ['a', 'b'] } } })).ok,
    ).toBe(true)
  })

  it('slots.methods 缺失 / 空 / 全字符串以外 / 重复 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ slots: { 'toy.cap': {} } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ slots: { 'toy.cap': { methods: [] } } })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ slots: { 'toy.cap': { methods: ['a', 1] } } })).ok).toBe(
      false,
    )
    expect(parsePluginDecl(baseDecl({ slots: { 'toy.cap': { methods: ['a', 'a'] } } })).ok).toBe(
      false,
    )
  })

  it('methods[cap] 与 slots[cap].methods 同给：同集合通过，不一致拒', () => {
    const same = parsePluginDecl(
      baseDecl({
        methods: { 'toy.cap': ['a', 'b'] },
        slots: { 'toy.cap': { methods: ['b', 'a'] } },
      }),
    )
    expect(same.ok).toBe(true)

    const missing = parsePluginDecl(
      baseDecl({
        methods: { 'toy.cap': ['a'] },
        slots: { 'toy.cap': { methods: ['a', 'b'] } },
      }),
    )
    expect(missing.ok).toBe(false)
  })

  it('methods 省略 → ok:true 且为 {}；同包 slots[cap].methods 仍解析（契约单源）', () => {
    const omitted = baseDecl({ slots: { 'toy.echo': { methods: ['echo'] } } })
    delete (omitted as Record<string, Json>)['methods']
    const result = parsePluginDecl(omitted)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.decl.methods).toEqual({})
      expect(result.decl.slots['toy.echo'].methods).toEqual(['echo'])
    }
  })

  it('提供方 methods[cap] 省略、拥有方 slots[cap].methods 存在 → 解析通过', () => {
    const omitted = baseDecl({
      implements: ['toy.cap'],
      slots: { 'toy.cap': { methods: ['a', 'b'] } },
    })
    delete (omitted as Record<string, Json>)['methods']
    expect(parsePluginDecl(omitted).ok).toBe(true)
  })

  it('拥有方 implements 自身 slots → 允许', () => {
    const result = parsePluginDecl(
      baseDecl({ implements: ['toy.cap'], methods: {}, slots: { 'toy.cap': { methods: ['m'] } } }),
    )
    expect(result.ok).toBe(true)
  })

  it('needs 与自身 slots 同键：mode many 通过，mode one 拒', () => {
    const many = parsePluginDecl(
      baseDecl({
        slots: { 'toy.cap': { methods: ['m'] } },
        needs: { 'toy.cap': { mode: 'many' } },
      }),
    )
    expect(many.ok).toBe(true)

    const one = parsePluginDecl(
      baseDecl({ slots: { 'toy.cap': { methods: ['m'] } }, needs: { 'toy.cap': { mode: 'one' } } }),
    )
    expect(one.ok).toBe(false)
  })

  it('many 无 methods 且无本包 slots 契约 → decl 层放行（契约可能在他方，入世期判定）', () => {
    const result = parsePluginDecl(baseDecl({ needs: { 'toy.cap': { mode: 'many' } } }))
    expect(result.ok).toBe(true)
  })
})

describe('parsePluginDecl implements 校验', () => {
  it('合法能力类名（含空数组）→ 原样解析', () => {
    const multi = parsePluginDecl(baseDecl({ implements: ['toy.a', 'toy.b'] }))
    expect(multi.ok).toBe(true)
    if (multi.ok) expect(multi.decl.implements).toEqual(['toy.a', 'toy.b'])

    const empty = parsePluginDecl(baseDecl({ implements: [] }))
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.decl.implements).toEqual([])
  })

  it('保留类 host / 空串 / 原型键 → ok:false（不得静默退化为零端点）', () => {
    for (const cap of ['host', '', '__proto__', 'constructor', 'prototype']) {
      const result = parsePluginDecl(baseDecl({ implements: [cap] }))
      expect(result.ok, `implements=${JSON.stringify(cap)} 应被拒`).toBe(false)
      if (!result.ok) expect(result.reasons).toEqual(['bad_plugin_decl'])
    }
  })

  it('重复项 / 非字符串项 / 非数组 → ok:false', () => {
    expect(parsePluginDecl(baseDecl({ implements: ['toy.a', 'toy.a'] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ implements: ['toy.a', 1] })).ok).toBe(false)
    expect(parsePluginDecl(baseDecl({ implements: 'toy.a' })).ok).toBe(false)
  })
})
