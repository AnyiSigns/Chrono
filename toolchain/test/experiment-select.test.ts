// 单判定实验：把 `router.select` 的纯判定用工具链表达成 term，并与生产实现逐例比对。
// 参考实现在本文件内复刻 `plugins/router/execute/select.ts` 的语义（别名候选优先、否则主名、
// 都不在候选内回 no_candidate），只用于实验对照；生产插件不改。

import { describe, expect, it } from 'vitest'
import { t } from '../builder.ts'
import { lowerProgram } from '../lower.ts'
import { runTerm } from '../testkit.ts'
import type { Json, Sugar } from '../lower.ts'
import type { Program } from '../validate.ts'

/** 候选选择判定：候选顺序即偏好序，取第一个 ∈ aliases 的候选；无则回 primary（须在候选内）。 */
function selectSugar(): Sugar {
  const bag = t.arg(0)
  const cands = t.get(bag, ['candidates'])
  const aliases = t.getOr(bag, ['aliases'], t.lit([]))
  const primary = t.getOr(bag, ['primary'], t.lit(''))
  const step: Sugar = t.if(
    t.pred('ne', t.get(t.arg(0), ['chosen']), t.lit(null)),
    t.arg(0),
    t.if(
      t.contains(t.get(t.arg(0), ['aliases']), t.arg(1)),
      t.obj({
        chosen: t.arg(1),
        aliases: t.get(t.arg(0), ['aliases']),
        primary: t.get(t.arg(0), ['primary']),
      }),
      t.arg(0),
    ),
  )
  const folded = t.fold(
    cands,
    t.obj({ chosen: t.lit(null), aliases, primary }),
    step,
  )
  const chosen = t.get(folded, ['chosen'])
  return t.if(
    t.pred('ne', chosen, t.lit(null)),
    chosen,
    t.if(
      t.contains(cands, primary),
      primary,
      t.obj({ ok: t.lit(false), error: t.obj({ code: t.lit('no_candidate') }) }),
    ),
  )
}

interface SelectArgs {
  candidates: string[]
  aliases: string[]
  primary: string
}

/** 生产实现语义的参考复刻（不含入参形态校验；校验归 argsSchema / 服务前置）。 */
function selectReference(input: SelectArgs): Json {
  const aliasCandidate = input.candidates.find((c) => input.aliases.includes(c))
  const chosen = aliasCandidate ?? input.primary
  if (!input.candidates.includes(chosen)) {
    return { ok: false, error: { code: 'no_candidate' } }
  }
  return chosen
}

const CASES: SelectArgs[] = [
  { candidates: ['model-a', 'model-b'], aliases: ['model-b'], primary: 'model-a' },
  { candidates: ['model-a', 'model-b'], aliases: ['model-c'], primary: 'model-a' },
  { candidates: ['model-a', 'model-b'], aliases: [], primary: 'model-a' },
  { candidates: ['model-a', 'model-b'], aliases: [], primary: 'model-c' },
  { candidates: ['only'], aliases: ['only'], primary: 'only' },
  { candidates: ['a', 'b', 'c'], aliases: ['c', 'b'], primary: 'a' },
  { candidates: ['a', 'b', 'c'], aliases: ['a'], primary: 'a' },
  { candidates: ['a', 'b', 'c'], aliases: ['b', 'a'], primary: 'c' },
]

describe('实验：router.select 判定进 term', () => {
  const program: Program = {
    terms: { 'terms/select.json': selectSugar() },
    implements: ['router'],
    methods: { router: ['select'] },
  }

  it('表达得出：每个用例与生产语义逐字段一致', () => {
    for (const input of CASES) {
      const result = runTerm(program, 'terms/select.json', { args: [input as unknown as Json] })
      expect(result, JSON.stringify(input)).toEqual({ ok: true, value: selectReference(input) })
    }
  })

  it('确定性：同源两次编译逐字节一致；同输入两次求值一致', () => {
    const first = lowerProgram({ 'terms/select.json': selectSugar() })
    const second = lowerProgram({ 'terms/select.json': selectSugar() })
    expect(JSON.stringify(first.asts)).toBe(JSON.stringify(second.asts))
    const input = CASES[5]
    const a = runTerm(program, 'terms/select.json', { args: [input as unknown as Json] })
    const b = runTerm(program, 'terms/select.json', { args: [input as unknown as Json] })
    expect(a).toEqual(b)
  })
})
