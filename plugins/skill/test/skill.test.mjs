// skill 包形状 / 内容测试 + 服务级读写往返（零依赖，node --test）。
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

test('plugin.json 字段齐全且形态合法（服务身份）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'skill')
  assert.equal(decl.schema, 'schema/skill.json')
  assert.deepEqual(decl.implements, ['skill'])
  assert.deepEqual(decl.methods, { skill: ['read', 'write'] })
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

test('commands 声明 skill.read（只读）+ skill.write（整份）', () => {
  const decl = readJson('plugin.json')
  const byName = Object.fromEntries(decl.commands.map((command) => [command.name, command]))
  assert.deepEqual(byName['skill.read'], { name: 'skill.read', entry: 'terms/skill.read.json', readonly: true })
  assert.equal(byName['skill.write'].entry, 'terms/skill.write.json')
  assert.equal(byName['skill.write'].argsSchema, 'schema/skill.write.args.json')
})

test('skill schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/skill.json'), 'skill.schema')
  assertWhitelist(readJson('schema/skill.write.args.json'), 'skill.write.args')
})

test('skill schema 顶层为内联 skills 列表', () => {
  const schema = readJson('schema/skill.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['version', 'skills'])
  assert.equal(schema.properties.skills.type, 'array')
  assert.equal(schema.properties.skills.items.type, 'object')
})

test('skill 触发字段齐全且形状写入 description', () => {
  const schema = readJson('schema/skill.json')
  const item = schema.properties.skills.items
  const triggers = item.properties.triggers
  assert.equal(triggers.type, 'object')
  for (const field of ['keywords', 'file_globs', 'explicit']) {
    assert.equal(triggers.properties[field].type, 'array', `triggers.${field}`)
    assert.equal(triggers.properties[field].items.type, 'string', `triggers.${field}.items`)
  }
  for (const field of ['keywords', 'file_globs', 'explicit']) {
    assert.ok(triggers.description.includes(field), `triggers.description 缺 ${field}`)
    assert.ok(schema.description.includes(field), `顶层 description 缺 ${field}`)
  }
})

test('skill scope / body / enabled 字段齐全', () => {
  const item = readJson('schema/skill.json').properties.skills.items
  assert.deepEqual(item.properties.scope.properties.kind.enum, ['global', 'workspace', 'session'])
  assert.equal(item.properties.body.type, 'string')
  assert.equal(item.properties.enabled.type, 'boolean')
  assert.ok(item.required.includes('triggers'))
  assert.ok(item.required.includes('body'))
})

test('terms：skill.read 取世界切片问 owner；skill.write 传命令 args', () => {
  assert.deepEqual(readJson('terms/skill.read.json'), ['eff', 'skill', 'read', ['g', ['ids', 'skill']]])
  assert.deepEqual(readJson('terms/skill.write.json'), ['eff', 'skill', 'write', ['v', 0]])
})

test('tools/default-body.json 为空技能清单', () => {
  assert.deepEqual(readJson('tools/default-body.json'), { version: 1, skills: [] })
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

// ---- 服务级：读写往返 / 幂等 / 重放 ----

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
      const id = `sk-${seq}`
      const expected = Array.isArray(expect) ? expect : [expect]
      const timer = setTimeout(() => rejectRequest(new Error(`timeout ${kind}`)), 8000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}: ${JSON.stringify(message)}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  return {
    hello: () => request('hello', { impl: 'skill', gen: 'g' }, 'manifest'),
    read: (args) =>
      request('call', { port: 'skill', method: 'read', args, env: { run: 'r1', thread: null, now: 0 } }, 'result'),
    write: (body) =>
      request(
        'call',
        { port: 'skill', method: 'write', args: { body }, env: { run: 'r1', thread: null, now: 0 } },
        ['result', 'error'],
      ),
    close: () => child.stdin.end(),
    exit,
  }
}

const SKILLS = {
  version: 1,
  skills: [{ id: 's1', name: '测试', description: 'd', triggers: { keywords: ['t'] }, body: 'b' }],
}

test('read 合并世界基线；write 写自有存储、幂等短路', async () => {
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.deepEqual(manifest.methods.skill, ['read', 'write'])
    assert.equal(manifest.state, 'durable')

    const first = await drv.read({ body: SKILLS, active: null })
    assert.equal(first.value.body.skills[0].id, 's1')

    const written = await drv.write({ version: 1, skills: [] })
    assert.deepEqual(written.value, { ok: true, changed: true })
    assert.equal(written.value.$directives, undefined, '运行记录写不产世界写计划')
    const after = await drv.read({ body: SKILLS, active: null })
    assert.deepEqual(after.value.body.skills, [])

    const again = await drv.write({ version: 1, skills: [] })
    assert.deepEqual(again.value, { ok: true, changed: false })
  } finally {
    drv.close()
  }
  await drv.exit
})

test('write 形态非法 → bad_args', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const bad = await drv.write({ version: 1 })
    assert.equal(bad.kind, 'error')
    assert.equal(bad.code, 'bad_args')
  } finally {
    drv.close()
  }
  await drv.exit
})

test('④ 追加日志：新进程重放读回上次写入', async () => {
  const dir = join(tmpdir(), 'kilo', `skill-store-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  const first = startService({ CHRONO_PLUGIN_DATA: dir })
  try {
    await first.hello()
    await first.write(SKILLS)
  } finally {
    first.close()
  }
  await first.exit

  const second = startService({ CHRONO_PLUGIN_DATA: dir })
  try {
    await second.hello()
    const view = await second.read({})
    assert.equal(view.value.body.skills[0].id, 's1')
  } finally {
    second.close()
  }
  await second.exit
})
