import { describe, expect, it } from 'vitest'
import { validateArgs, validateArgsSchema } from '../args-schema.ts'
import type { Json } from '../../../kernel/index.ts'

describe('argsSchema 元校验（入世门禁）', () => {
  it('白名单子集 + 注记键 → 通过（含嵌套 schema）', () => {
    const schema: Json = {
      type: 'object',
      title: '参数',
      description: '命令参数',
      default: { n: 1 },
      examples: [{ n: 1 }],
      properties: {
        n: { type: 'integer', minimum: 0, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', minLength: 1 } },
        kind: { enum: ['a', 'b'] },
      },
      required: ['n'],
      additionalProperties: false,
    }
    expect(validateArgsSchema(schema)).toEqual({ ok: true })
  })

  it('白名单外关键词 → 入世拒（不静默忽略）', () => {
    for (const keyword of ['oneOf', '$ref', 'pattern', 'format', 'uniqueItems', 'if']) {
      const result = validateArgsSchema({ type: 'object', [keyword]: [] })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toContain(keyword)
    }
  })

  it('嵌套 schema 里的白名单外关键词同样拒', () => {
    const result = validateArgsSchema({
      type: 'object',
      properties: { n: { type: 'integer', pattern: '^1$' } },
    })
    expect(result.ok).toBe(false)
  })

  it('形态非法：type / required / additionalProperties / enum / 界', () => {
    expect(validateArgsSchema({ type: 'string-list' }).ok).toBe(false)
    expect(validateArgsSchema({ required: 'n' }).ok).toBe(false)
    expect(validateArgsSchema({ additionalProperties: 'no' }).ok).toBe(false)
    expect(validateArgsSchema({ enum: [] }).ok).toBe(false)
    expect(validateArgsSchema({ minItems: 1.5 }).ok).toBe(false)
    expect(validateArgsSchema({ maxLength: -1 }).ok).toBe(false)
    expect(validateArgsSchema({ items: 5 }).ok).toBe(false)
    expect(validateArgsSchema({ properties: { n: 5 } }).ok).toBe(false)
    expect(validateArgsSchema(5 as Json).ok).toBe(false)
    expect(validateArgsSchema(null).ok).toBe(false)
  })

  it('深嵌套 schema / 深嵌套 args：显式栈不爆（递归实现会 RangeError）', () => {
    const DEPTH = 20_000
    let schema: Json = { type: 'integer' }
    for (let i = 0; i < DEPTH; i++) schema = { type: 'array', items: schema }
    expect(validateArgsSchema(schema)).toEqual({ ok: true })
    let value: Json = 1
    for (let i = 0; i < DEPTH; i++) value = [value]
    expect(validateArgs(schema, value)).toBe(true)
  })
})

describe('argsSchema 机械校验（命令门禁）', () => {
  const objectSchema: Json = {
    type: 'object',
    properties: {
      n: { type: 'integer', minimum: 0 },
      name: { type: 'string' },
      flags: { type: 'array', items: { type: 'boolean' }, maxItems: 2 },
    },
    required: ['n'],
    additionalProperties: false,
  }

  it('type 单值判定：object/array/string/number/integer/boolean/null', () => {
    expect(validateArgs({ type: 'object' }, {})).toBe(true)
    expect(validateArgs({ type: 'object' }, [])).toBe(false)
    expect(validateArgs({ type: 'array' }, [])).toBe(true)
    expect(validateArgs({ type: 'string' }, 'x')).toBe(true)
    expect(validateArgs({ type: 'number' }, 1.5)).toBe(true)
    expect(validateArgs({ type: 'integer' }, 1.5)).toBe(false)
    expect(validateArgs({ type: 'integer' }, 1)).toBe(true)
    expect(validateArgs({ type: 'boolean' }, true)).toBe(true)
    expect(validateArgs({ type: 'boolean' }, 1)).toBe(false)
    expect(validateArgs({ type: 'null' }, null)).toBe(true)
    expect(validateArgs({ type: 'null' }, undefined as unknown as Json)).toBe(true)
    expect(validateArgs({ type: 'null' }, 0)).toBe(false)
  })

  it('required 只查键存在（null 也算存在）与 properties 逐键校验', () => {
    expect(validateArgs(objectSchema, { n: 1 })).toBe(true)
    expect(validateArgs(objectSchema, { n: -1 })).toBe(false)
    expect(validateArgs(objectSchema, { n: 1.2 })).toBe(false)
    expect(validateArgs(objectSchema, {})).toBe(false)
    expect(validateArgs(objectSchema, { n: null })).toBe(false)
    expect(validateArgs({ required: ['n'] }, { n: null })).toBe(true)
  })

  it('additionalProperties 缺省 true / false 拒未知键', () => {
    expect(validateArgs({ properties: { n: {} } }, { n: 1, extra: 2 })).toBe(true)
    expect(validateArgs({ additionalProperties: false }, {})).toBe(true)
    expect(validateArgs(objectSchema, { n: 1, x: 2 })).toBe(false)
    expect(validateArgs(objectSchema, { n: 1, flags: [true, false] })).toBe(true)
    expect(validateArgs(objectSchema, { n: 1, flags: [true, false, true] })).toBe(false)
    expect(validateArgs(objectSchema, { n: 1, flags: [1] })).toBe(false)
  })

  it('enum / const 用 deepEq：结构相等、无隐式转换', () => {
    expect(validateArgs({ enum: [{ a: 1 }, 'x'] }, { a: 1 })).toBe(true)
    expect(validateArgs({ enum: [{ a: 1 }] }, { a: 2 })).toBe(false)
    expect(validateArgs({ const: [1, 2] }, [1, 2])).toBe(true)
    expect(validateArgs({ const: 2 }, '2')).toBe(false)
  })

  it('数值界与长度界（Unicode 码点）', () => {
    expect(validateArgs({ minimum: 1, maximum: 3 }, 2)).toBe(true)
    expect(validateArgs({ minimum: 1, maximum: 3 }, 4)).toBe(false)
    expect(validateArgs({ minItems: 1, maxItems: 2 }, [1, 2])).toBe(true)
    expect(validateArgs({ minItems: 1, maxItems: 2 }, [])).toBe(false)
    expect(validateArgs({ minLength: 2 }, '😀')).toBe(false)
    expect(validateArgs({ minLength: 1 }, '😀')).toBe(true)
    expect(validateArgs({ maxLength: 1 }, '😀😀')).toBe(false)
  })

  it('无序关键词只作用于对应类型（非 object 不查 required/properties）', () => {
    expect(validateArgs({ required: ['n'], additionalProperties: false }, 'x')).toBe(true)
    expect(validateArgs({ items: { type: 'integer' } }, 'x')).toBe(true)
  })

  it('缺省 args = null 的校验口径', () => {
    expect(validateArgs(objectSchema, null)).toBe(false)
    expect(validateArgs({ type: 'null' }, null)).toBe(true)
  })
})
