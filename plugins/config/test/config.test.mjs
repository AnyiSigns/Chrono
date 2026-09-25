// config 包形状 / 内容测试 + 服务级读写往返（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(pkgRoot, 'execute', 'main.ts')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

const DECL_FIELDS = [
  'identity',
  'schema',
  'implements',
  'methods',
  'pins',
  'start',
  'protocol',
  'restart',
  'health',
  'state',
  'exclusive',
  'members',
  'commands',
]

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
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
])
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])

function assertWhitelist(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), where)
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue
    assert.ok(KEYWORDS.has(key), `${where}.${key} 不在白名单`)
    const value = schema[key]
    switch (key) {
      case 'type':
        assert.equal(typeof value, 'string', `${where}.type`)
        assert.ok(TYPES.has(value), `${where}.type 非法：${value}`)
        break
      case 'properties':
        for (const [name, child] of Object.entries(value)) {
          assertWhitelist(child, `${where}.properties.${name}`)
        }
        break
      case 'items':
        assertWhitelist(value, `${where}.items`)
        break
      case 'required':
        assert.ok(Array.isArray(value) && value.every((x) => typeof x === 'string'), where)
        break
      case 'additionalProperties':
        assert.equal(typeof value, 'boolean', `${where}.additionalProperties 只能布尔`)
        break
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, `${where}.enum`)
        break
      case 'minimum':
      case 'maximum':
        assert.equal(typeof value, 'number', `${where}.${key}`)
        break
      case 'minItems':
      case 'maxItems':
      case 'minLength':
      case 'maxLength':
        assert.ok(Number.isInteger(value) && value >= 0, `${where}.${key}`)
        break
      default:
        break
    }
  }
}

// ---- 包形状 ----

test('plugin.json 字段齐全且形态合法（服务身份）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'config')
  assert.equal(decl.schema, 'schema/config.json')
  assert.deepEqual(decl.implements, ['config'])
  assert.deepEqual(decl.methods, { config: ['read', 'write'] })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.state, 'durable')
  assert.deepEqual(decl.exclusive, ['data'])
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
    { kind: 'schema', path: 'schema/' },
  ])
})

test('commands 声明 config.read（只读）+ config.write（补丁）', () => {
  const decl = readJson('plugin.json')
  const byName = Object.fromEntries(decl.commands.map((command) => [command.name, command]))
  assert.deepEqual(byName['config.read'], {
    name: 'config.read',
    entry: 'terms/config.read.json',
    readonly: true,
  })
  assert.equal(byName['config.write'].entry, 'terms/config.write.json')
  assert.equal(byName['config.write'].argsSchema, 'schema/config.write.args.json')
  assert.equal(byName['config.write'].readonly, undefined)
})

test('config schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/config.json'), 'config.schema')
  assertWhitelist(readJson('schema/config.write.args.json'), 'config.write.args')
})

test('config schema 关键字段齐全', () => {
  const schema = readJson('schema/config.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['version', 'params', 'permission', 'ui', 'providers'])
  assert.deepEqual(schema.properties.permission.enum, ['auto', 'severe', 'review', 'deny'])
  assert.deepEqual(schema.properties.ui.properties.theme.enum, ['day', 'night', 'system'])
  assert.equal(schema.properties.ui.properties.sidebar_width.minimum, 220)
  assert.equal(schema.properties.ui.properties.sidebar_width.maximum, 420)
  assert.equal(schema.properties.providers.additionalProperties, true)
  assert.equal(schema.properties.version.type, 'integer')
  assert.equal(schema.properties.params.type, 'object')
  assert.equal(schema.properties.params.properties.max_tokens.type, 'integer')
  assert.deepEqual(schema.properties.params.properties.reasoning.type, 'string')
})

test('terms：config.read 取世界切片问 owner；config.write 传命令 args', () => {
  assert.deepEqual(readJson('terms/config.read.json'), ['eff', 'config', 'read', ['g', ['ids', 'config']]])
  assert.deepEqual(readJson('terms/config.write.json'), ['eff', 'config', 'write', ['v', 0]])
})

test('tools/default-body.json 是可落地的默认 body', () => {
  const body = readJson('tools/default-body.json')
  assert.equal(body.version, 1)
  assert.equal(body.permission, 'review')
  assert.deepEqual(body.ui, { theme: 'system', style: '', sidebar_width: 260 })
  assert.deepEqual(body.providers, {})
  assert.equal(body.vendor, undefined)
  assert.equal(body.model, undefined)
})

test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
})

test('package.json 零依赖且带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式 #<数字>')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})

// ---- 服务级：读写往返 / 阈值镜像 / 幂等 / 重放 ----

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

function startService(env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: pkgRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const decoder = createDecoder()
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', () => {})
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  let seq = 0
  const request = (kind, fields, expect) =>
    new Promise((resolveRequest, rejectRequest) => {
      seq += 1
      const id = `cfg-${seq}`
      const timer = setTimeout(() => rejectRequest(new Error(`timeout ${kind}`)), 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.kind !== expect) {
          rejectRequest(new Error(`expected ${expect} got ${message.kind}: ${JSON.stringify(message)}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  return {
    hello: () => request('hello', { impl: 'config', gen: 'g' }, 'manifest'),
    read: (args) =>
      request('call', { port: 'config', method: 'read', args, env: { run: 'r1', thread: null, now: 0 } }, 'result'),
    write: (patch) =>
      request(
        'call',
        { port: 'config', method: 'write', args: { patch }, env: { run: 'r1', thread: null, now: 0 } },
        'result',
      ),
    close: () => child.stdin.end(),
    exit,
  }
}

const WORLD = { version: 1, permission: 'review', params: {}, ui: { theme: 'system' } }

test('read 合并世界基线；write 运行记录不产世界写计划', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.deepEqual(manifest.methods.config, ['read', 'write'])
    assert.equal(manifest.state, 'durable')

    const first = await drv.read({ body: WORLD, active: null })
    assert.equal(first.value.body.permission, 'review')
    assert.equal(first.value.body.ui.theme, 'system')

    // 界面偏好（运行记录）→ 只落 ④，不产世界写计划
    const written = await drv.write({ ui: { theme: 'night' } })
    assert.deepEqual(written.value, { ok: true, changed: true })
    const after = await drv.read({ body: WORLD, active: null })
    assert.equal(after.value.body.ui.theme, 'night')
    assert.equal(after.value.body.permission, 'review')

    // 同值重复写幂等
    const again = await drv.write({ ui: { theme: 'night' } })
    assert.deepEqual(again.value, { ok: true, changed: false })
  } finally {
    drv.close()
  }
  await drv.exit
})

test('write 阈值变化 → 返回世界写计划镜像 permission / params', async () => {
  const drv = startService()
  try {
    await drv.hello()
    await drv.read({ body: WORLD, active: null })
    const plan = await drv.write({ permission: 'deny' })
    const directives = plan.value.$directives
    assert.equal(directives.length, 1)
    assert.equal(directives[0].kind, 'write')
    const ops = directives[0].request.args.ops
    assert.equal(ops[0].op, 'put')
    assert.deepEqual(ops[0].args.body, { version: 1, permission: 'deny', params: {} })
    assert.deepEqual(ops[1], {
      op: 'add_gen',
      args: { id: 'config', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
    })
    // 补丁深合并：params 子键合并、null 删键
    const patched = await drv.write({ params: { reasoning: 'high' } })
    assert.equal(patched.value.$directives[0].request.args.ops[0].args.body.params.reasoning, 'high')
    const removed = await drv.write({ params: { reasoning: null } })
    assert.equal(
      Object.hasOwn(removed.value.$directives[0].request.args.ops[0].args.body.params, 'reasoning'),
      false,
    )
  } finally {
    drv.close()
  }
  await drv.exit
})

test('④ 追加日志：新进程重放读回上次写入', async () => {
  const dir = join(tmpdir(), 'kilo', `config-store-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const first = startService({ CHRONO_PLUGIN_DATA: dir })
  try {
    await first.hello()
    await first.read({ body: WORLD, active: null })
    await first.write({ vendor: 'deepseek', ui: { theme: 'night' } })
  } finally {
    first.close()
  }
  await first.exit

  const second = startService({ CHRONO_PLUGIN_DATA: dir })
  try {
    await second.hello()
    const view = await second.read({ body: WORLD, active: null })
    assert.equal(view.value.body.vendor, 'deepseek')
    assert.equal(view.value.body.ui.theme, 'night')
  } finally {
    second.close()
  }
  await second.exit
})
