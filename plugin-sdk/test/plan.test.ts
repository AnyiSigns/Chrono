// 计划值与形态 helper：extern 观测、结构化失败、按段合并。

import { describe, expect, it } from 'vitest'

import {
  directivesOf,
  errorValue,
  externDirective,
  externOnly,
  isErrorValue,
  mergeDirectives,
} from '../plan.ts'
import { asString, isRecord } from '../json.ts'

describe('计划值 helper', () => {
  it('externOnly 只含一条 extern 观测', () => {
    expect(externOnly({ ok: true })).toEqual({
      $directives: [{ kind: 'extern', payload: { ok: true } }],
    })
    expect(externDirective(1)).toEqual({ kind: 'extern', payload: 1 })
  })

  it('errorValue / isErrorValue 结构化失败作数据', () => {
    const failed = errorValue('toy_failed', 'nope')
    expect(failed).toEqual({ ok: false, error: { code: 'toy_failed', message: 'nope' } })
    expect(isErrorValue(failed)).toBe(true)
    expect(isErrorValue({ ok: true })).toBe(false)
  })

  it('mergeDirectives 按段序拼接条目', () => {
    const merged = mergeDirectives([externOnly(1), externOnly(2), { value: 3 }])
    expect(merged).toEqual({
      $directives: [
        { kind: 'extern', payload: 1 },
        { kind: 'extern', payload: 2 },
      ],
    })
    expect(directivesOf(merged)).toHaveLength(2)
    expect(directivesOf({ value: 1 })).toEqual([])
  })

  it('isRecord / asString 形态判定', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(asString('x')).toBe('x')
    expect(asString('')).toBeNull()
    expect(asString(1)).toBeNull()
  })
})
