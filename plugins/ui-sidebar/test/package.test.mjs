// 包形状测试：零 schema、members = execute + term、pins 两条、命令入口 term 形状、
// `.worldignore`、README 守卫、无宿主 / 内核 import、web 层无散落中文与硬编码色值、
// 叶子纯模块零 react import、构建声明与客户端半边契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

const METHOD_NAMES = [
  'ping',
  'clientRead',
  'newConversation',
  'selectConversation',
  'renameConversation',
  'deleteConversation',
  'restoreConversation',
  'branchConversation',
  'listWorkspaces',
  'pickWorkspace',
  'addWorkspace',
  'removeWorkspace',
  'revealWorkspace',
]

const COMMAND_NAMES = [
  'session.new',
  'session.select',
  'session.rename',
  'session.delete',
  'session.restore',
  'session.branch',
  'workspace.list',
  'workspace.pick',
  'workspace.add',
  'workspace.remove',
  'workspace.reveal',
  'ui-sidebar.client.read',
]

test('plugin.json 省略 schema 且其余字段齐全（含 build、无 exclusive）', () => {
  const decl = readJson('plugin.json')
  assert.equal(Object.hasOwn(decl, 'schema'), false, '不得以 null 占位 schema，直接省略')
  const expected = ['identity', 'implements', 'methods', 'pins', 'start', 'build', 'protocol', 'restart', 'health', 'state', 'members', 'commands']
  assert.deepEqual(Object.keys(decl).sort(), [...expected].sort())
  assert.equal(Object.hasOwn(decl, 'exclusive'), false, 'HTTP 面作废后不得再声明独占端口')
  assert.equal(decl.identity, 'ui-sidebar')
  assert.equal(decl.start, 'node execute/main.js')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
})

test('构建声明：npm ci + esbuild 打包脚本，令牌过白名单且不含 =', () => {
  const decl = readJson('plugin.json')
  assert.ok(Array.isArray(decl.build) && decl.build.length === 2, 'build 应为两步')
  assert.deepEqual(decl.build[0], { cmd: 'npm', args: ['ci'] })
  assert.deepEqual(decl.build[1], { cmd: 'node', args: ['execute/build.mjs'] })
  const SAFE = /^[A-Za-z0-9_./:@,+-]+$/
  for (const step of decl.build) {
    assert.ok(SAFE.test(step.cmd), `cmd 令牌非法：${step.cmd}`)
    for (const arg of step.args) {
      assert.ok(SAFE.test(arg), `args 令牌非法：${arg}`)
      assert.ok(!arg.includes('='), `args 不得含 =：${arg}`)
    }
  }
  const script = readText(join('execute', 'build.mjs'))
  assert.match(script, /from 'esbuild'/, '构建脚本应调用 esbuild')
  assert.match(script, /execute|web\/entry\.tsx/, '构建脚本应以 entry.tsx 为入口')
  assert.match(script, /dist\/entry\.js/, '构建脚本产物应为 dist/entry.js')
})

test('能力类为 ui-sidebar（ping + clientRead + 各命令服务方法）；pins 两条（session / workspace）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-sidebar'])
  assert.deepEqual(decl.methods, { 'ui-sidebar': METHOD_NAMES })
  assert.deepEqual(decl.pins, { session: 'session', workspace: 'workspace' })
})

test('members = execute + term；命令入口 term 全部存在且形状为 eff 到本插件能力类', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
  ])
  assert.deepEqual(decl.commands.map((command) => command.name), COMMAND_NAMES)
  for (const command of decl.commands) {
    assert.equal(Object.hasOwn(command, 'argsSchema'), false, `${command.name} 不声明 argsSchema`)
    const term = readJson(command.entry)
    assert.equal(term[0], 'eff', `${command.entry} 应为 eff`)
    assert.equal(term[1], 'ui-sidebar', `${command.entry} 应 eff 到本插件能力类（自能力路由）`)
    assert.ok(METHOD_NAMES.includes(term[2]), `${command.entry} 方法名 ${term[2]} 应在声明内`)
  }
  const readonly = Object.fromEntries(decl.commands.map((command) => [command.name, command.readonly]))
  assert.equal(readonly['workspace.list'], true, 'workspace.list 只读')
  assert.equal(readonly['ui-sidebar.client.read'], true, 'client.read 只读')
  for (const name of COMMAND_NAMES.filter((name) => name !== 'workspace.list' && name !== 'ui-sidebar.client.read')) {
    assert.equal(readonly[name], undefined, `${name} 非只读`)
  }
})

test('入口 term 投影读 / 命令 args 口径', () => {
  assert.deepEqual(readJson('terms/session.new.json'), ['eff', 'ui-sidebar', 'newConversation', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/session.select.json'), ['eff', 'ui-sidebar', 'selectConversation', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/session.branch.json'), ['eff', 'ui-sidebar', 'branchConversation', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/workspace.list.json'), ['eff', 'ui-sidebar', 'listWorkspaces', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/workspace.add.json'), ['eff', 'ui-sidebar', 'addWorkspace', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/workspace.pick.json'), ['eff', 'ui-sidebar', 'pickWorkspace', ['c', null]])
  assert.deepEqual(readJson('terms/workspace.reveal.json'), ['eff', 'ui-sidebar', 'revealWorkspace', ['v', 0]])
  assert.deepEqual(readJson('terms/client.read.json'), ['eff', 'ui-sidebar', 'clientRead', ['v', 0]])
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

test('package.json 带 esbuild devDep、typecheck 脚本与锁文件', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(typeof pkg.devDependencies?.esbuild, 'string')
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
  assert.ok(pkg.files.includes('package-lock.json'), 'files 应含 package-lock.json')
  assert.ok(existsSync(join(pkgRoot, 'package-lock.json')), '锁文件应存在')
  assert.ok(existsSync(join(pkgRoot, 'tsconfig.json')), 'tsconfig.json 应存在')
})

test('插件源码与测试不 import 宿主 / 内核 / 客户端（tools/ 冒烟脚本除外）', () => {
  const files = []
  const skip = new Set(['node_modules', 'tools', 'dist'])
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // `tools/e2e-smoke.mjs` 是唯一例外：冒烟脚本可 import 宿主内部模块。
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path)
      } else if (entry.isFile() && /\.(mjs|ts|tsx|js|json)$/.test(entry.name)) files.push(path)
    }
  }
  walk(pkgRoot)
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    assert.ok(!/packages\/(host|kernel|client)/.test(source), `${file} 引用了宿主 / 内核 / 客户端`)
    assert.ok(!/from\s+['"]\.\.\/\.\.\/packages/.test(source), `${file} 跨包相对 import`)
  }
})

test('叶子纯模块零 react import（可 grep 断言）', () => {
  const leaves = ['sidebar-model.ts', 'badges.ts', 'width.ts', 'export.ts', 'messages.ts', 'confirm.ts']
  for (const name of leaves) {
    const source = readText(join('execute', 'web', name))
    assert.ok(!/from\s+['"]react/.test(source), `${name} 不应 import react`)
  }
})

test('客户端半边入口为 entry.tsx，导出 contract=2 与 register，且不再导出 mount', () => {
  assert.ok(existsSync(join(pkgRoot, 'execute', 'web', 'entry.tsx')), 'entry.tsx 应存在')
  const source = readText(join('execute', 'web', 'entry.tsx'))
  assert.match(source, /export const contract = '2'/)
  assert.match(source, /export (async )?function register\(/)
  assert.ok(!/export (async )?function mount\(/.test(source), '不应再导出 mount')
  assert.ok(existsSync(join(pkgRoot, 'tsconfig.json')), 'tsconfig.json 应存在')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式')
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

test('web 层代码无散落中文（文案集中在 messages）与硬编码色值', () => {
  const webDir = join(pkgRoot, 'execute', 'web')
  for (const entry of readdirSync(webDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (!/\.(ts|tsx|js)$/.test(entry.name)) continue
    if (/^messages\./.test(entry.name)) continue
    const source = stripComments(readFileSync(join(webDir, entry.name), 'utf8'))
    assert.ok(!/[\u4e00-\u9fff]/.test(source), `${entry.name} 含散落中文文案`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), `${entry.name} 含硬编码色值`)
  }
})
