// 包形状测试：零 schema、members 仅 terms、start 空、无 execute 成员、命令入口 term。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

test('plugin.json 省略 schema 且其余字段齐全', () => {
  const decl = readJson('plugin.json')
  assert.equal(Object.hasOwn(decl, 'schema'), false, '不得以 null 占位 schema，直接省略')
  const expected = [
    'identity',
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
  assert.deepEqual(Object.keys(decl).sort(), [...expected].sort())
  assert.equal(decl.identity, 'ui-notify')
  assert.equal(decl.start, '')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
})

test('members 仅 terms（无 execute 成员 ⇒ 无服务进程）', () => {
  const members = readJson('plugin.json').members
  assert.deepEqual(members, [{ kind: 'term', path: 'terms/' }])
  assert.equal(members.some((member) => member.kind === 'execute'), false)
})

test('能力类与方法为 ui-notify ping 占位，且无 pins', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-notify'])
  assert.deepEqual(decl.methods, { 'ui-notify': ['ping'] })
  assert.deepEqual(decl.pins, {})
})

test('commands 声明 notify.state 且无 argsSchema（无参可省）', () => {
  const commands = readJson('plugin.json').commands
  assert.equal(commands.length, 1)
  assert.equal(commands[0].name, 'notify.state')
  assert.equal(commands[0].entry, 'terms/notify.state.json')
  assert.equal(Object.hasOwn(commands[0], 'argsSchema'), false)
})

test('入口 term 直出 config body（投影读在入口 term）', () => {
  assert.deepEqual(readJson('terms/notify.state.json'), ['g', ['ids', 'config', 'body']])
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
