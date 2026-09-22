// 逻辑级测试：直接 import execute 源码（不 spawn 服务），覆盖规范 JSON / argsSchema 方言 / caps 校验 / 配置。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, resolveCacheEnabled, resolveConcurrency } from '../execute/config.ts'
import { canonicalJson, deepEq } from '../execute/json.ts'
import { normalizeCaps, sanitizeArgsSchema, validateArgs, validateArgsSchema } from '../execute/schema-validate.ts'

test('canonicalJson：键序无关、嵌套确定', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
})

test('deepEq：结构相等', () => {
  assert.equal(deepEq({ a: [1, 2] }, { a: [1, 2] }), true)
  assert.equal(deepEq({ a: 1 }, { a: 1, b: 2 }), false)
  assert.equal(deepEq([1, 'x'], [1, 'x']), true)
  assert.equal(deepEq(null, null), true)
})

test('validateArgsSchema：白名单内通过、白名单外拒、注记允许', () => {
  assert.equal(validateArgsSchema({ type: 'object', properties: { path: { type: 'string', description: 'x' } } }).ok, true)
  assert.equal(validateArgsSchema({ type: 'object', properties: { path: { type: 'string', pattern: '^x' } } }).ok, false)
  assert.equal(validateArgsSchema({ type: 'object', oneOf: [] }).ok, false)
  assert.equal(validateArgsSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 9 } } }).ok, true)
})

test('validateArgs：类型 / required / additionalProperties / enum / integer / 码点长度', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 2, maxLength: 3 },
      n: { type: 'integer', minimum: 1, maximum: 9 },
      mode: { enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    },
    required: ['path'],
    additionalProperties: false,
  }
  assert.equal(validateArgs(schema, { path: 'ab' }).ok, true)
  assert.equal(validateArgs(schema, {}).ok, false)
  assert.equal(validateArgs(schema, { path: 'ab', extra: 1 }).ok, false)
  assert.equal(validateArgs(schema, { path: 'a' }).ok, false)
  assert.equal(validateArgs(schema, { path: 'abcd' }).ok, false)
  assert.equal(validateArgs(schema, { path: 'ab', n: 1.5 }).ok, false)
  assert.equal(validateArgs(schema, { path: 'ab', n: 3 }).ok, true)
  assert.equal(validateArgs(schema, { path: 'ab', mode: 'c' }).ok, false)
  assert.equal(validateArgs(schema, { path: 'ab', tags: ['x', 'y', 'z'] }).ok, false)
  // 码点计长：一个 emoji 记 1
  assert.equal(validateArgs({ type: 'object', properties: { s: { type: 'string', maxLength: 1 } } }, { s: '😀' }).ok, true)
})

test('normalizeCaps：对象形与字符串 net', () => {
  const ok = normalizeCaps({ fs: { read: 'workspace', write: 'none' }, net: 'limited', timeout_ms: 1000 })
  assert.equal(ok.ok, true)
  assert.equal(ok.caps.net, 'limited')
  assert.equal(ok.caps.timeout_ms, 1000)
  // 旧布尔 false → none
  assert.equal(normalizeCaps({ fs: { read: 'none', write: 'none' }, net: false }).caps.net, 'none')
  // 布尔 true 无合法含义 → 拒
  assert.equal(normalizeCaps({ fs: { read: 'none', write: 'none' }, net: true }).ok, false)
  // 非法字符串 → 拒
  assert.equal(normalizeCaps({ fs: { read: 'none', write: 'none' }, net: 'sometimes' }).ok, false)
  // 缺 net → unset；缺 fs.read → 拒
  assert.equal(normalizeCaps({ fs: { read: 'none', write: 'none' } }).caps.net, 'unset')
  assert.equal(normalizeCaps({ fs: { write: 'none' } }).ok, false)
  assert.equal(normalizeCaps(null).ok, false)
})

test('sanitizeArgsSchema：剥掉白名单外关键词（供外部 MCP 工具）', () => {
  const clean = sanitizeArgsSchema({
    type: 'object',
    $schema: 'http://json-schema.org/draft-07/schema#',
    properties: { q: { type: 'string', pattern: 'x' } },
  })
  assert.equal(clean.$schema, undefined)
  assert.equal(clean.properties.q.pattern, undefined)
  assert.equal(clean.properties.q.type, 'string')
})

test('配置：并发上限解析与缓存开关', () => {
  assert.equal(resolveConcurrency({}), DEFAULT_CONCURRENCY)
  assert.equal(resolveConcurrency({ concurrency: 2 }), 2)
  assert.equal(resolveConcurrency({ concurrency: 0 }), DEFAULT_CONCURRENCY)
  assert.equal(resolveConcurrency({ concurrency: 10000 }), MAX_CONCURRENCY)
  assert.equal(resolveCacheEnabled({}, true), true)
  assert.equal(resolveCacheEnabled({ cache: false }, true), false)
  assert.equal(resolveCacheEnabled({ cache: { enabled: false } }, true), false)
})
