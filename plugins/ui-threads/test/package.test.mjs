// 包形状测试：零 schema、members = execute + term、无 pins、命令入口 term 形状、build 声明、
// `.worldignore`、README 守卫、无宿主 / 内核 import、web 层无散落中文与硬编码色值。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

test('plugin.json 省略 schema、无 exclusive、其余字段齐全', () => {
  const decl = readJson('plugin.json')
  assert.equal(Object.hasOwn(decl, 'schema'), false, '不得以 null 占位 schema，直接省略')
  assert.equal(Object.hasOwn(decl, 'exclusive'), false, '客户端半边自交付后不再独占端口')
  const expected = [
    'identity',
    'implements',
    'methods',
    'pins',
    'start',
    'build',
    'protocol',
    'restart',
    'health',
    'state',
    'members',
    'commands',
  ]
  assert.deepEqual(Object.keys(decl).sort(), [...expected].sort())
  assert.equal(decl.identity, 'ui-threads')
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
})

test('能力类为 ui-threads（ping + threads.state + client.read）；pins = 宿主解析', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-threads'])
  assert.deepEqual(decl.methods, { 'ui-threads': ['ping', 'threads.state', 'client.read'] })
  assert.deepEqual(decl.pins, { host: 'host' })
})

test('members = execute + term；命令入口 term 存在且只读、无参声明', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
  ])
  assert.deepEqual(decl.commands.map((command) => command.name), ['threads.state', 'ui-threads.client.read'])
  for (const command of decl.commands) {
    assert.equal(Object.hasOwn(command, 'argsSchema'), false, `${command.name} 无参不应声明 argsSchema`)
    assert.ok(readText(command.entry).length > 0, `${command.entry} 应存在`)
    assert.equal(command.readonly, true, `${command.name} 只读`)
  }
})

test('入口 term 形状：threads.state 传投影切片；client.read 传命令 args', () => {
  assert.deepEqual(readJson('terms/threads.state.json'), [
    'eff',
    'ui-threads',
    'threads.state',
    ['g', ['ids']],
  ])
  assert.deepEqual(readJson('terms/ui-threads.client.read.json'), [
    'eff',
    'ui-threads',
    'client.read',
    ['v', 0],
  ])
})

test('build 声明：npm ci + node execute/build.mjs，args 不含 `=`', () => {
  const decl = readJson('plugin.json')
  assert.ok(Array.isArray(decl.build) && decl.build.length === 2, 'build 应为两步')
  for (const step of decl.build) {
    assert.equal(typeof step.cmd, 'string')
    assert.ok(Array.isArray(step.args))
    for (const arg of step.args) {
      assert.equal(typeof arg, 'string')
      assert.equal(arg.includes('='), false, `args 令牌不得含 '='：${arg}`)
    }
  }
  assert.deepEqual(decl.build[0], { cmd: 'npm', args: ['ci', '--no-audit', '--no-fund'] })
  assert.deepEqual(decl.build[1], { cmd: 'node', args: ['execute/build.mjs'] })
  assert.ok(existsSync(join(pkgRoot, 'execute', 'build.mjs')), '构建脚本 execute/build.mjs 应存在')
})

test('.worldignore 声明 test/、tools/ 与 execute/web/dist/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
  assert.ok(lines.includes('execute/web/dist/'))
})

test('package.json：devDeps 含 esbuild、锁文件入 files、带 typecheck 与测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(typeof pkg.devDependencies?.esbuild, 'string')
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('package-lock.json'))
})

test('tsconfig.json 存在：include 只含 execute/web，paths 指 @chrono/ui-contract', () => {
  const tsconfig = readJson('tsconfig.json')
  assert.deepEqual(tsconfig.include, ['execute/web/**/*.ts', 'execute/web/**/*.tsx'])
  assert.equal(tsconfig.compilerOptions.paths['@chrono/ui-contract'][0], '../../types/ui-contract.d.ts')
  assert.equal(tsconfig.compilerOptions.noEmit, true)
})

test('插件源码与测试不 import 宿主 / 内核 / 客户端（tools/ 冒烟脚本除外）', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // `tools/e2e-smoke.mjs` 是唯一例外：冒烟脚本可 import 宿主内部模块（见 plugins.md §三）。
      if (entry.isDirectory() && entry.name !== 'tools') walk(path)
      else if (entry.isFile() && /\.(mjs|ts|tsx|js|json)$/.test(entry.name)) files.push(path)
    }
  }
  walk(pkgRoot)
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/packages\/(host|kernel|client)/.test(source), `${file} 引用了宿主 / 内核 / 客户端`)
    assert.ok(!/from\s+['"]\.\.\/\.\.\/packages/.test(source), `${file} 跨包相对 import`)
  }
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式 #<数字>')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})

/** 去掉注释，只留代码（注释不属「文案」，且可能举例色值）；不碰字符串与模板字面量。 */
function stripComments(source) {
  let out = ''
  let index = 0
  let quote = null
  while (index < source.length) {
    const ch = source[index]
    const next = source[index + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (ch === quote) quote = null
      index += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      out += ch
      index += 1
      continue
    }
    if (ch === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (ch === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += ch
    index += 1
  }
  return out
}

test('web 层代码无散落中文（文案集中在 messages.ts）与硬编码色值', () => {
  const webDir = join(pkgRoot, 'execute', 'web')
  for (const name of readdirSync(webDir)) {
    if (!/\.(ts|tsx)$/.test(name) || name === 'messages.ts') continue
    const source = stripComments(readFileSync(join(webDir, name), 'utf8'))
    assert.ok(!/[\u4e00-\u9fff]/.test(source), `${name} 含散落中文文案`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), `${name} 含硬编码色值`)
  }
})
