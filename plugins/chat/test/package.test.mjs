// chat 包形状 / 接线 / term 入口测试（零依赖，node --test）。
// 覆盖：plugin.json 12 字段、wiring 段序与切片、入口 term 只发自能力 eff（H21）、
// .worldignore、README 无计划引用、服务代码不 import 宿主 / 内核 / 客户端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(PKG_ROOT, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

/** 递归列出目录下全部文件（含子目录）。 */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(path))
    else out.push(path)
  }
  return out
}

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
  'members',
  'commands',
]

test('plugin.json 12 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'chat')
  assert.equal(decl.schema, 'schema/wiring.json')
  assert.deepEqual(decl.implements, ['chat'])
  assert.deepEqual(decl.methods, { chat: ['send', 'history', 'resume'] })
  assert.deepEqual(decl.pins, {
    session: 'session',
    model: 'model-protocol',
    context: 'context-window',
    'session-title': 'session-title',
    'loop-policy': 'loop-policy',
  })
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
    { kind: 'schema', path: 'schema/' },
  ])
  assert.equal(decl.health.probe, 'chat.send')
})

test('pins 含 loop-policy（#33 替换管道）', () => {
  const decl = readJson('plugin.json')
  assert.equal(decl.pins['loop-policy'], 'loop-policy')
})

test('commands 声明 chat.send / chat.history / chat.resume 且入口正确', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(
    decl.commands.map((command) => [command.name, command.entry]),
    [
      ['chat.send', 'terms/chat.send.json'],
      ['chat.history', 'terms/chat.history.json'],
      ['chat.resume', 'terms/chat.resume.json'],
    ],
  )
})

test('wiring 切片 / title 声明 / 空槽行为（段序归 #33 图数据）', () => {
  const wiring = readJson('schema/wiring.json')
  assert.equal(Object.hasOwn(wiring, 'pipeline'), false, '静态管道段序应删除')
  assert.deepEqual(wiring.slices, {
    prompt: true,
    l2: true,
    l1: true,
    skill: true,
    recall: false,
    history: true,
    style: true,
  })
  assert.equal(typeof wiring.system_prompt, 'string')
  assert.ok(wiring.system_prompt.length > 0)
  assert.deepEqual(wiring.tools, [])
  assert.equal(wiring.on_empty_slot, 'noop')
  assert.equal(wiring.on_budget, 'fail')
  assert.equal(wiring.title.segment, 'session-title.generate')
  assert.equal(wiring.title.when, 'first_message')
  assert.equal(wiring.title.on_fail, 'ignore')
  assert.equal(wiring.title.title_default, '新对话')
  assert.deepEqual(wiring.stream, { topic: 'model.delta' })
})

test('入口 term：send/history 自能力 eff + 投影切片，resume 收 eval args', () => {
  const send = readJson('terms/chat.send.json')
  assert.deepEqual(send, ['eff', 'chat', 'send', ['g', ['ids']]])
  const history = readJson('terms/chat.history.json')
  assert.deepEqual(history, ['eff', 'chat', 'history', ['g', ['ids']]])
  const resume = readJson('terms/chat.resume.json')
  assert.deepEqual(resume, ['eff', 'chat', 'resume', ['v', 0]])
})

test('terms/ 只保留三个命令入口，无装配模板残留', () => {
  const names = readdirSync(join(PKG_ROOT, 'terms')).sort()
  assert.deepEqual(names, ['chat.history.json', 'chat.resume.json', 'chat.send.json'])
})

test('.worldignore 声明 test/ 与 tools/；package.json 零依赖带测试脚本', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})

test('红线：execute/ · src/ · terms/ · test/ 不出现宿主 / 内核 / client 引用（只经线协议 + pins）', () => {
  const forbidden = /packages\/(host|kernel|client)/
  for (const root of ['execute', 'src', 'terms', 'test']) {
    const dir = join(PKG_ROOT, root)
    if (!existsSync(dir)) continue
    for (const file of listFiles(dir)) {
      assert.equal(forbidden.test(readFileSync(file, 'utf8')), false, `${file} 出现宿主 / 内核 / client 引用`)
    }
  }
})
