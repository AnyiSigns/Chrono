// 包形状测试：零 schema、members = execute + term、needs 四条、命令入口 term 形状、
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
  'listTurns',
  'listConversations',
  'listWorkspaces',
  'addWorkspace',
  'removeWorkspace',
]

const COMMAND_NAMES = [
  'session.new',
  'session.select',
  'session.rename',
  'session.delete',
  'session.restore',
  'session.branch',
  'session.turns',
  'session.list',
  'workspace.list',
  'workspace.pick',
  'workspace.add',
  'workspace.remove',
  'workspace.reveal',
  'ui-sidebar.client.read',
]


test('构建声明：npm ci + 共享构建脚本，令牌过白名单且不含 =', () => {
  const decl = readJson('plugin.json')
  assert.ok(Array.isArray(decl.build) && decl.build.length === 2, 'build 应为两步')
  assert.deepEqual(decl.build[0], { cmd: 'npm', args: ['ci'] })
  assert.deepEqual(decl.build[1], { cmd: 'node', args: ['../../plugin-sdk/tools/build-ui.mjs'] })
  const SAFE = /^[A-Za-z0-9_./:@,+-]+$/
  for (const step of decl.build) {
    assert.ok(SAFE.test(step.cmd), `cmd 令牌非法：${step.cmd}`)
    for (const arg of step.args) {
      assert.ok(SAFE.test(arg), `args 令牌非法：${arg}`)
      assert.ok(!arg.includes('='), `args 不得含 =：${arg}`)
    }
  }
  const script = readText(join('..', '..', 'plugin-sdk', 'tools', 'build-ui.mjs'))
  assert.match(script, /esbuild/, '共享脚本应调用 esbuild')
  assert.match(script, /entry\.tsx/, '共享脚本应以 entry.tsx 为入口')
  assert.match(script, /dist/, '共享脚本产物应落 dist/')
})

test('能力类为 ui-sidebar（ping + clientRead + 各命令服务方法）；needs 四条（session / workspace / workspace-picker / input）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-sidebar'])
  assert.deepEqual(decl.methods, { 'ui-sidebar': METHOD_NAMES })
  assert.deepEqual(decl.pins, { host: 'host' })
  assert.deepEqual(decl.needs, {
    session: { mode: 'one' },
    workspace: { mode: 'one' },
    'workspace-picker': { mode: 'one' },
    input: { mode: 'one' },
  })
})

/** 跨身份入口 term：`workspace.pick` / `workspace.reveal` 直接 eff `workspace-picker`。 */
const CROSS_IDENTITY_TERMS = {
  'workspace.pick': { port: 'workspace-picker', methods: ['pick'] },
  'workspace.reveal': { port: 'workspace-picker', methods: ['reveal'] },
}

test('members = execute + term；命令入口 term 存在且形状为 eff（自能力路由或 workspace-picker）', () => {
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
    const cross = CROSS_IDENTITY_TERMS[command.name]
    if (cross !== undefined) {
      assert.equal(term[1], cross.port, `${command.entry} 应 eff ${cross.port}`)
      assert.ok(cross.methods.includes(term[2]), `${command.entry} 方法名 ${term[2]} 应在 ${cross.port} 声明内`)
    } else {
      assert.equal(term[1], 'ui-sidebar', `${command.entry} 应 eff 到本插件能力类（自能力路由）`)
      assert.ok(METHOD_NAMES.includes(term[2]), `${command.entry} 方法名 ${term[2]} 应在声明内`)
    }
  }
  const readonly = Object.fromEntries(decl.commands.map((command) => [command.name, command.readonly]))
  assert.equal(readonly['session.turns'], true, 'session.turns 只读')
  assert.equal(readonly['session.list'], true, 'session.list 只读')
  assert.equal(readonly['workspace.list'], true, 'workspace.list 只读')
  assert.equal(readonly['ui-sidebar.client.read'], true, 'client.read 只读')
  const READONLY = new Set(['session.turns', 'session.list', 'workspace.list', 'ui-sidebar.client.read'])
  for (const name of COMMAND_NAMES.filter((name) => !READONLY.has(name))) {
    assert.equal(readonly[name], undefined, `${name} 非只读`)
  }
})

test('入口 term 不再预取投影 / 命令 args 口径', () => {
  assert.deepEqual(readJson('terms/session.new.json'), ['eff', 'ui-sidebar', 'newConversation', ['v', 0]])
  assert.deepEqual(readJson('terms/session.select.json'), ['eff', 'ui-sidebar', 'selectConversation', ['v', 0]])
  assert.deepEqual(readJson('terms/session.rename.json'), ['eff', 'ui-sidebar', 'renameConversation', ['v', 0]])
  assert.deepEqual(readJson('terms/session.delete.json'), ['eff', 'ui-sidebar', 'deleteConversation', ['v', 0]])
  assert.deepEqual(readJson('terms/session.restore.json'), ['eff', 'ui-sidebar', 'restoreConversation', ['v', 0]])
  assert.deepEqual(readJson('terms/session.branch.json'), ['eff', 'ui-sidebar', 'branchConversation', ['v', 0]])
  assert.deepEqual(readJson('terms/workspace.list.json'), ['eff', 'ui-sidebar', 'listWorkspaces', ['v', 0]])
  assert.deepEqual(readJson('terms/session.turns.json'), ['eff', 'ui-sidebar', 'listTurns', ['v', 0]])
  assert.deepEqual(readJson('terms/session.list.json'), ['eff', 'ui-sidebar', 'listConversations', ['v', 0]])
  assert.deepEqual(readJson('terms/workspace.add.json'), ['eff', 'ui-sidebar', 'addWorkspace', ['v', 0]])
  assert.deepEqual(readJson('terms/workspace.remove.json'), ['eff', 'ui-sidebar', 'removeWorkspace', ['v', 0]])
  assert.deepEqual(readJson('terms/workspace.pick.json'), ['eff', 'workspace-picker', 'pick', ['c', null]])
  assert.deepEqual(readJson('terms/workspace.reveal.json'), ['eff', 'workspace-picker', 'reveal', ['v', 0]])
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
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['@chrono/ui-kit'])
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
