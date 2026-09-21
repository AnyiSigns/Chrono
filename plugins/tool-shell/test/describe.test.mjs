// `tool-shell` describe 契约测试：单工具 shell 的四要素 / argsSchema / caps / idempotent / modes / languages / render。
// 直接导入 execute 模块（Node 原生 TS 类型剥离），不经服务进程。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeTools, DEFAULT_CAPS, LANGUAGES } from '../execute/describe.ts'

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

function shell() {
  const tools = describeTools().tools
  assert.equal(tools.length, 1)
  return tools[0]
}

function checkSchemaKeys(schema, path = 'argsSchema') {
  assert.equal(typeof schema, 'object')
  for (const [key, child] of Object.entries(schema)) {
    assert.ok(ALLOWED_SCHEMA_KEYS.has(key), `白名单外关键词 ${path}.${key}`)
    if (key === 'properties') {
      for (const [name, sub] of Object.entries(child)) {
        checkSchemaKeys(sub, `${path}.properties.${name}`)
      }
    } else if (key === 'items') {
      checkSchemaKeys(child, `${path}.items`)
    }
  }
}

test('describe 只回单工具 shell', () => {
  assert.deepEqual(describeTools().tools.map((tool) => tool.name), ['shell'])
})

test('四要素必填非空且 param_semantics 覆盖必填参数', () => {
  const tool = shell()
  for (const element of ['intent', 'when_to_use', 'boundaries']) {
    assert.equal(typeof tool[element], 'string', element)
    assert.ok(tool[element].trim().length > 0, `${element} 不得为空`)
  }
  const semantics = tool.param_semantics
  assert.ok(Object.keys(semantics).length > 0)
  for (const key of tool.argsSchema.required) {
    assert.ok(semantics[key] !== undefined, `param_semantics 未覆盖 ${key}`)
  }
})

test('argsSchema：mode enum / input / language 白名单 / 必填 input / 闭集', () => {
  const schema = shell().argsSchema
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['input'])
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.properties.mode.enum, ['command', 'code'])
  assert.equal(schema.properties.input.type, 'string')
  assert.equal(schema.properties.input.minLength, 1)
  assert.deepEqual(schema.properties.language.enum, ['javascript', 'python', 'shell'])
  checkSchemaKeys(schema)
})

test('caps 对象形含 fs.read；net 为字符串枚举、与 sandbox 形状一致', () => {
  const caps = shell().caps
  assert.equal(typeof caps.fs.read, 'string')
  assert.equal(typeof caps.fs.write, 'string')
  assert.equal(typeof caps.net, 'string', 'caps.net 必须是字符串 scope，不得用布尔')
  assert.ok(['none', 'limited', 'all', 'unset'].includes(caps.net), `非法 caps.net：${caps.net}`)
  assert.equal(caps.net, 'none')
  for (const key of ['cpu_ms', 'mem_mb', 'timeout_ms', 'output_max', 'procs_max']) {
    assert.equal(typeof caps[key], 'number', key)
  }
  assert.deepEqual(caps, DEFAULT_CAPS)
})

test('idempotent:false、modes 与 languages 白名单', () => {
  const tool = shell()
  assert.equal(tool.idempotent, false)
  assert.deepEqual(tool.modes, ['command', 'code'])
  assert.deepEqual(tool.languages, ['javascript', 'python', 'shell'])
  assert.deepEqual(tool.languages, LANGUAGES)
})

test('render 描述符 = 默认收缩卡片 + terminal 展开 + 非 live', () => {
  assert.deepEqual(shell().render, {
    form: 'card',
    label: 'shell',
    summary: '{input}',
    tone: 'plain',
    detail: { kind: 'terminal' },
    live: false,
  })
})
