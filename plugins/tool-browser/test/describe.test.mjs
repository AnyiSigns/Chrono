// `describe` 自述面测试：四要素 / render / caps / idempotent / argsSchema 白名单 / modes。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describe, TOOL_NAME } from '../execute/describe.ts'

const ELEMENTS = ['intent', 'when_to_use', 'param_semantics', 'boundaries']
const ACTIONS = ['open', 'navigate', 'click', 'type', 'press', 'wait_for', 'extract', 'screenshot', 'close']
const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'title',
  'description',
  'default',
  'examples',
])

function tools() {
  return describe().tools
}

test('单工具 webbrowser：四要素齐备且 param_semantics 覆盖必填参数', () => {
  const list = tools()
  assert.equal(list.length, 1)
  assert.equal(list[0].name, TOOL_NAME)
  for (const element of ELEMENTS) {
    const value = list[0][element]
    const present =
      element === 'param_semantics'
        ? typeof value === 'object' && value !== null && Object.keys(value).length > 0
        : typeof value === 'string' && value.trim().length > 0
    assert.ok(present, `缺少 ${element}`)
  }
  for (const key of list[0].argsSchema.required) {
    assert.ok(Object.prototype.hasOwnProperty.call(list[0].param_semantics, key), `param_semantics 未覆盖 ${key}`)
  }
})

test('caps 对象形含 fs.read / net（字符串 all），idempotent 为 false', () => {
  const tool = tools()[0]
  assert.equal(tool.caps.fs.read, 'none')
  assert.equal(tool.caps.fs.write, 'none')
  assert.equal(tool.caps.net, 'all')
  assert.equal(tool.idempotent, false)
})

test('render 静态 json：单工具只能声明一个 detail.kind，不随 action 变化', () => {
  const tool = tools()[0]
  assert.deepEqual(tool.render, {
    form: 'card',
    label: 'webbrowser',
    summary: '{action}  {url}',
    tone: 'plain',
    detail: { kind: 'json' },
    live: false,
  })
})

test('argsSchema 只用白名单关键词，action 枚举九个分档', () => {
  const schema = tools()[0].argsSchema
  assert.deepEqual(schema.required, ['action'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.action.enum, ACTIONS)
  function check(node, path) {
    for (const [key, child] of Object.entries(node)) {
      assert.ok(ALLOWED_SCHEMA_KEYS.has(key), `白名单外关键词 ${path}.${key}`)
      if (key === 'properties') {
        for (const [name, sub] of Object.entries(child)) check(sub, `${path}.properties.${name}`)
      } else if (key === 'items') {
        check(child, `${path}.items`)
      }
    }
  }
  check(schema, 'argsSchema')
})

test('modes 与 action 分档一致', () => {
  assert.deepEqual(tools()[0].modes, ACTIONS)
})
