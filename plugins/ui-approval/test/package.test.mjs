// 包形状测试：零 schema、members = execute + term、pins 一条、命令入口 term 形状、
// `.worldignore`、README 守卫、无宿主 / 内核 import、web 层无散落中文与硬编码色值、
// 客户端半边构建声明与类型门禁。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
    'concurrent_methods',
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
  assert.equal(decl.identity, 'ui-approval')
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
  assert.equal(Object.hasOwn(decl, 'exclusive'), false, '客户端半边自交付，不再独占端口')
})

test('build 声明：npm ci + node execute/build.mjs，args 不含 =（shell 安全白名单）', () => {
  const decl = readJson('plugin.json')
  assert.equal(Array.isArray(decl.build), true)
  assert.equal(decl.build[0].cmd, 'npm')
  assert.deepEqual(decl.build[0].args, ['ci', '--no-audit', '--no-fund'])
  // esbuild CLI 的字符串选项必须 `--opt=value`，与「令牌不含 =」冲突，故构建走脚本内 JS API。
  assert.equal(decl.build[1].cmd, 'node')
  assert.deepEqual(decl.build[1].args, ['execute/build.mjs'])
  assert.ok(readText('execute/build.mjs').length > 0, '构建脚本必须随包入世')
  for (const step of decl.build) {
    for (const token of [step.cmd, ...step.args]) {
      assert.ok(/^[A-Za-z0-9_./:@,+-]+$/.test(token), `构建令牌非法：${token}`)
      assert.ok(!token.includes('='), `构建令牌不得含 =：${token}`)
    }
  }
})

test('能力类为 ui-approval（ping 占位 + 三条命令方法 + client.read）；pins = approval + 宿主解析', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-approval'])
  assert.deepEqual(decl.methods, {
    'ui-approval': ['ping', 'list', 'decide', 'decide_all', 'client.read'],
  })
  assert.deepEqual(decl.pins, { approval: 'approval', host: 'host' })
})

test('并发安全声明只含纯只读方法：list / client.read；裁决与控制方法留在串行链', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.concurrent_methods, ['list', 'client.read'])
  const declared = new Set(decl.methods['ui-approval'])
  for (const method of decl.concurrent_methods) {
    assert.ok(declared.has(method), `并发声明的方法须已声明：${method}`)
  }
  for (const excluded of ['decide', 'decide_all', 'ping']) {
    assert.ok(!decl.concurrent_methods.includes(excluded), `${excluded} 发世界写计划 / 属控制面，不得并发`)
  }
})

test('members = execute + term；四条命令入口 term 全部存在且无 argsSchema', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
  ])
  assert.deepEqual(
    decl.commands.map((command) => command.name),
    ['approval.list', 'approval.decide', 'approval.decide_all', 'ui-approval.client.read'],
  )
  for (const command of decl.commands) {
    assert.equal(Object.hasOwn(command, 'argsSchema'), false, `${command.name} 无参不应声明 argsSchema`)
    assert.ok(readText(command.entry).length > 0, `${command.entry} 应存在`)
  }
  const readonly = Object.fromEntries(decl.commands.map((command) => [command.name, command.readonly]))
  assert.equal(readonly['approval.list'], true, 'approval.list 只读')
  assert.equal(readonly['approval.decide'], undefined, 'approval.decide 非只读')
  assert.equal(readonly['approval.decide_all'], undefined, 'approval.decide_all 非只读')
  assert.equal(readonly['ui-approval.client.read'], true, 'client.read 只读')
})

test('入口 term 形状：eff 到自身能力类；client.read 用 Var 0 取命令 args', () => {
  assert.deepEqual(readJson('terms/approval.list.json'), ['eff', 'ui-approval', 'list', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/approval.decide.json'), ['eff', 'ui-approval', 'decide', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/approval.decide_all.json'), [
    'eff',
    'ui-approval',
    'decide_all',
    ['g', ['ids']],
  ])
  assert.deepEqual(readJson('terms/ui-approval.client.read.json'), [
    'eff',
    'ui-approval',
    'client.read',
    ['v', 0],
  ])
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

test('package.json 带 esbuild devDep / typecheck 脚本 / files 含 lockfile', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}), ['esbuild'])
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
  assert.ok(pkg.files.includes('package-lock.json'))
})

test('tsconfig.json 存在且 include 只含 execute/web', () => {
  const tsconfig = readJson('tsconfig.json')
  assert.deepEqual(tsconfig.include, ['execute/web/**/*.ts', 'execute/web/**/*.tsx'])
  assert.deepEqual(tsconfig.compilerOptions.paths, {
    '@chrono/ui-contract': ['../../types/ui-contract.d.ts'],
  })
  assert.equal(tsconfig.compilerOptions.noEmit, true)
  assert.equal(tsconfig.compilerOptions.jsx, 'react-jsx')
})

test('插件源码与测试不 import 宿主 / 内核 / 客户端（tools/ 冒烟脚本除外）', () => {
  const files = []
  const SKIP_DIRS = new Set(['tools', 'node_modules', 'dist'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) walk(path)
      else if (entry.isFile() && entry.name !== 'package-lock.json' && /\.(mjs|ts|tsx|js|json)$/.test(entry.name)) {
        files.push(path)
      }
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

test('叶子纯模块不 import react（model.ts / messages.ts）', () => {
  for (const name of ['model.ts', 'messages.ts']) {
    const source = readFileSync(join(pkgRoot, 'execute', 'web', name), 'utf8')
    assert.ok(!/from\s+['"]react/.test(source), `${name} import 了 react`)
  }
})

test('客户端半边源码为 entry.tsx，旧 entry.js / DOM / 网络层已删', () => {
  const webDir = join(pkgRoot, 'execute', 'web')
  const names = new Set(readdirSync(webDir))
  assert.ok(names.has('entry.tsx'), '缺 execute/web/entry.tsx')
  for (const retired of ['entry.js', 'dom.js', 'styles.js', 'client.js', 'sse.js']) {
    assert.ok(!names.has(retired), `旧客户端半边文件仍在：${retired}`)
  }
})

test('服务半边 HTTP 面已删（http-server / port / routes / static / inbound-guard）', () => {
  const execDir = join(pkgRoot, 'execute')
  const names = new Set(readdirSync(execDir))
  for (const retired of ['http-server.ts', 'port.ts', 'routes.ts', 'static.ts', 'inbound-guard.ts']) {
    assert.ok(!names.has(retired), `HTTP 面文件仍在：${retired}`)
  }
})
