import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { validateProgram } from '../validate.ts'
import type { Program } from '../validate.ts'

const issuesOf = (p: unknown): string[] =>
  validateProgram(p as Program).issues.map((i) => i.message)

describe('静态校验器', () => {
  it('合法程序通过', () => {
    const program = {
      terms: {
        'terms/entry.json': t.fold(
          t.eff('judge', 'pick', t.lit(null)),
          t.lit(null),
          'terms/step.json',
        ),
        'terms/step.json': t.pred('lt', t.arg(1), t.arg(0)),
      },
      implements: ['judge'],
      methods: { judge: ['pick'] },
    }
    expect(validateProgram(program as unknown as Program).ok).toBe(true)
  })

  it('缺失引用 / 引用环 / 未声明 port', () => {
    expect(
      issuesOf({ terms: { 'terms/a.json': t.fold(t.lit([]), t.lit(0), 'terms/missing.json') } }),
    ).toContain('missing_ref: terms/missing.json')

    const cycle = {
      terms: {
        'terms/a.json': t.fold(t.lit([]), t.lit(0), 'terms/b.json'),
        'terms/b.json': t.fold(t.lit([]), t.lit(0), 'terms/a.json'),
      },
    }
    expect(issuesOf(cycle)).toContain('term_cycle')

    expect(issuesOf({ terms: { 'terms/e.json': t.eff('nope', 'm', t.lit(null)) } })).toContain(
      'undeclared_port: nope',
    )
  })

  it('方法未在该能力声明内', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('judge', 'bad', t.lit(null)) },
      implements: ['judge'],
      methods: { judge: ['pick'] },
    }
    expect(issuesOf(program)).toContain('undeclared_method: judge.bad')
  })

  it('跨身份（port 只在 pins 里）不校验方法名：工具链单包看不到被调声明', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('secrets', 'list', t.lit(null)) },
      implements: ['ui-settings'],
      methods: { 'ui-settings': ['view'] },
      pins: { secrets: 'secrets' },
    }
    expect(validateProgram(program as unknown as Program).ok).toBe(true)
  })

  it('仅声明 methods 的能力类仍按自调用校验方法名', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('local', 'ghost', t.lit(null)) },
      methods: { local: ['ok'] },
    }
    expect(issuesOf(program)).toContain('undeclared_method: local.ghost')
  })

  it('needs 键是合法端口，方法按 needs.methods 校验', () => {
    const ok = {
      terms: { 'terms/e.json': t.eff('chat-hook', 'onTurn', t.lit(null)) },
      needs: { 'chat-hook': { mode: 'many', methods: ['onTurn'] } },
    }
    expect(validateProgram(ok as unknown as Program).ok).toBe(true)

    const bad = {
      terms: { 'terms/e.json': t.eff('chat-hook', 'ghost', t.lit(null)) },
      needs: { 'chat-hook': { mode: 'many', methods: ['onTurn'] } },
    }
    expect(issuesOf(bad)).toContain('undeclared_method: chat-hook.ghost')
  })

  it('仅声明 slots 的端口不是端口，报 undeclared_port', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('chat-hook', 'onTurn', t.lit(null)) },
      slots: { 'chat-hook': { methods: ['onTurn'] } },
    }
    expect(issuesOf(program)).toContain('undeclared_port: chat-hook')
  })

  it('many 有本插件 slots 契约时优先按它校验方法名', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('chat-hook', 'ghost', t.lit(null)) },
      slots: { 'chat-hook': { methods: ['onTurn'] } },
      needs: { 'chat-hook': { mode: 'many', methods: ['onTurn'] } },
    }
    expect(issuesOf(program)).toContain('undeclared_method: chat-hook.ghost')
  })

  it('many 无可见契约时跳过方法名校验（契约在他包 slots）', () => {
    const program = {
      terms: { 'terms/e.json': t.eff('chat-hook', 'anything', t.lit(null)) },
      needs: { 'chat-hook': { mode: 'many' } },
    }
    expect(validateProgram(program as unknown as Program).ok).toBe(true)
  })

  it('one 默认跳过方法名，声明 needs.methods 则按其校验', () => {
    const skipped = {
      terms: { 'terms/e.json': t.eff('session-title', 'whatever', t.lit(null)) },
      needs: { 'session-title': { mode: 'one' } },
    }
    expect(validateProgram(skipped as unknown as Program).ok).toBe(true)

    const checked = {
      terms: { 'terms/e.json': t.eff('session-title', 'ghost', t.lit(null)) },
      needs: { 'session-title': { mode: 'one', methods: ['generate'] } },
    }
    expect(issuesOf(checked)).toContain('undeclared_method: session-title.ghost')
  })

  it('needs 键与 implements / pins / methods 冲突 → needs_conflict', () => {
    const impl = {
      terms: { 'terms/e.json': t.eff('x', 'm', t.lit(null)) },
      implements: ['x'],
      needs: { x: { mode: 'one' } },
    }
    expect(validateProgram(impl as unknown as Program).issues).toContainEqual({
      path: 'plugin.json/needs/x',
      message: 'needs_conflict: x',
    })

    const pinned = {
      terms: { 'terms/e.json': t.eff('y', 'm', t.lit(null)) },
      pins: { y: 'y' },
      needs: { y: { mode: 'one' } },
    }
    expect(issuesOf(pinned)).toContain('needs_conflict: y')
  })

  it('形态不合（未绑定 bind）被拦', () => {
    expect(issuesOf({ terms: { 'terms/b.json': t.bind('nope') } })).toContain('bad_sugar')
  })

  it('let 绑定含 eff 且被引用多次 → effect_reemitted', () => {
    const program = {
      terms: {
        'terms/a.json': t.let(
          [['p', t.eff('g', 'policy', t.lit(null))]],
          t.if(
            t.pred('eq', t.get(t.bind('p'), ['x']), t.lit(1)),
            t.lit('a'),
            t.get(t.bind('p'), ['y']),
          ),
        ),
      },
      implements: ['g'],
      methods: { g: ['policy'] },
    }
    expect(issuesOf(program)).toContain('effect_reemitted: p')
  })
})
