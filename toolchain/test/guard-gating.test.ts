// 第三方作者场景回归：门禁判定（列表成员判断）+ 「带效果的中间结果只发一次」正解。
// 成员判断没有现成 `in`，用 fold + pred eq 自搓；效果结果经 call 实参传入，callee 内用 arg(0) 复用——
// 避免 let/bind 写期宏复制 eff 导致的重复发射（见 spec.md「写期宏与偏值语义」）。
import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { runTerm } from '../testkit.ts'
import type { Json, Sugar } from '../lower.ts'
import type { Program } from '../validate.ts'

const STEP = 'terms/guard.member.step.json'

/** 成员判断：list 里是否有元素等于 ctx.tool。 */
const member = (list: Sugar): Sugar => t.fold(list, t.lit(false), STEP)

const program: Program = {
  implements: ['guard'],
  methods: { guard: ['policy'] },
  terms: {
    [STEP]: t.if(t.pred('eq', t.arg(1), t.ctx(['tool'])), t.lit(true), t.arg(0)),
    'terms/guard.decide.json': t.if(
      member(t.get(t.arg(0), ['deny'])),
      t.lit('deny'),
      t.if(member(t.get(t.arg(0), ['allow'])), t.lit('allow'), t.lit('review')),
    ),
    // eff 只求值一次：效果结果作 call 实参，callee 内 arg(0) 复用
    'terms/guard.json': t.call('terms/guard.decide.json', [
      t.eff('guard', 'policy', t.lit([])),
    ]),
  },
} as unknown as Program

const verdict = (tool: string, policy: Json) =>
  runTerm(program, 'terms/guard.json', { ctx: { tool }, effects: [policy] })

describe('guard.decide（第三方作者场景）', () => {
  it('命中 deny → deny', () => {
    expect(verdict('rm', { deny: ['rm'], allow: ['read'] })).toEqual({ ok: true, value: 'deny' })
  })
  it('命中 allow → allow', () => {
    expect(verdict('read', { deny: ['rm'], allow: ['read'] })).toEqual({ ok: true, value: 'allow' })
  })
  it('都未命中 → review', () => {
    expect(verdict('write', { deny: ['rm'], allow: ['read'] })).toEqual({ ok: true, value: 'review' })
  })
  it('空策略 → review', () => {
    expect(verdict('anything', { deny: [], allow: [] })).toEqual({ ok: true, value: 'review' })
  })
})
