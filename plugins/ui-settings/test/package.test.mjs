// 包形状测试：零 schema、members = execute + term、pins 两条、命令入口 term 形状、
// `.worldignore`、README 守卫、无宿主 / 内核 import、web 层无散落中文与硬编码色值。
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
  assert.equal(decl.identity, 'ui-settings')
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
})

test('能力类为 ui-settings ping 占位 + 模型 / 健康 / 记忆装配方法；pins 四条（model / secrets / retrieval / memory-maintenance）', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-settings'])
  assert.deepEqual(decl.methods, {
    'ui-settings': ['ping', 'vendors', 'profile', 'discover', 'health', 'scopes', 'view', 'search', 'edit', 'client.read', 'secret'],
  })
  assert.deepEqual(decl.pins, {
    model: 'model-protocol',
    secrets: 'secrets',
    retrieval: 'memory-retrieval',
    'memory-maintenance': 'memory-consolidate',
    session: 'session',
    'short-memory': 'short-memory',
    'memory-store': 'memory-store',
    skill: 'skill',
    config: 'config',
    host: 'host',
  })
})

test('并发方法白名单只含纯只读方法，写计划 / 副作用 / 控制面方法不得入内', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.concurrent_methods, ['vendors', 'health', 'scopes', 'view', 'search', 'client.read'])
  for (const name of ['profile', 'discover', 'edit', 'secret', 'ping']) {
    assert.ok(!decl.concurrent_methods.includes(name), `${name} 不得脱链（写计划 / 副作用 / 控制面）`)
  }
})

test('members = execute + term；命令入口 term 全部存在', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
  ])
  const names = decl.commands.map((command) => command.name)
  assert.deepEqual(names, [
    'model.vendors',
    'model.discover',
    'model.profile',
    'secrets.status',
    'settings.identities',
    'settings.skills',
    'orchestration.graph',
    'orchestration.scopes',
    'orchestration.health',
    'memory.view',
    'memory.search',
    'memory.edit',
    'ui-settings.client.read',
    'ui-settings.secret',
  ])
  for (const command of decl.commands) {
    assert.equal(Object.hasOwn(command, 'argsSchema'), false, `${command.name} 无参不应声明 argsSchema`)
    assert.ok(readText(command.entry).length > 0, `${command.entry} 应存在`)
  }
  const readonly = Object.fromEntries(decl.commands.map((command) => [command.name, command.readonly]))
  for (const name of [
    'model.vendors',
    'secrets.status',
    'settings.identities',
    'settings.skills',
    'orchestration.graph',
    'orchestration.scopes',
    'orchestration.health',
    'memory.view',
    'ui-settings.client.read',
    'ui-settings.secret',
  ]) {
    assert.equal(readonly[name], true, `${name} 只读`)
  }
  for (const name of [
    'model.discover',
    'model.profile',
    'memory.search',
    'memory.edit',
  ]) {
    assert.equal(readonly[name], undefined, `${name} 非只读`)
  }
})

test('入口 term 形状：投影读 / eff 端口与方法', () => {
  assert.deepEqual(readJson('terms/model.vendors.json'), ['eff', 'ui-settings', 'vendors', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/model.discover.json'), [
    'eff',
    'ui-settings',
    'discover',
    ['g', ['ids', 'input']],
  ])
  assert.deepEqual(readJson('terms/model.profile.json'), ['eff', 'ui-settings', 'profile', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/secrets.status.json'), ['eff', 'secrets', 'list', ['c', null]])
  assert.deepEqual(readJson('terms/settings.identities.json'), ['g', ['ids']])
  assert.deepEqual(readJson('terms/settings.skills.json'), ['eff', 'skill', 'read', ['g', ['ids', 'skill']]])
  assert.deepEqual(readJson('terms/orchestration.graph.json'), ['g', ['ids', 'loop-policy']])
  assert.deepEqual(readJson('terms/orchestration.scopes.json'), [
    'eff',
    'ui-settings',
    'scopes',
    ['g', ['ids', 'agents']],
  ])
  assert.deepEqual(readJson('terms/orchestration.health.json'), ['eff', 'ui-settings', 'health', ['g', ['ids']]])
  // 记忆三条：view / edit 传整份投影；search 的查询 args 与投影无法在 term 合流，传命令 args（内含 UI 取回的 ids）。
  assert.deepEqual(readJson('terms/memory.view.json'), ['eff', 'ui-settings', 'view', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/memory.edit.json'), ['eff', 'ui-settings', 'edit', ['g', ['ids']]])
  assert.deepEqual(readJson('terms/memory.search.json'), ['eff', 'ui-settings', 'search', ['v', 0]])
})

test('.worldignore 声明 test/ 与 tools/ 与 execute/web/dist/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
  assert.ok(lines.includes('execute/web/dist/'))
})

test('package.json 零运行期依赖，devDeps 只有 esbuild，带测试与类型脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.deepEqual(pkg.devDependencies, { esbuild: '^0.28.2' })
  assert.equal(pkg.scripts.test, 'node --test')
  assert.equal(pkg.scripts.typecheck, 'tsc --noEmit')
  assert.ok(pkg.files.includes('package-lock.json'))
  assert.ok(pkg.files.includes('tsconfig.json'))
})

test('插件源码与测试不 import 宿主 / 内核 / 客户端（tools/ 冒烟脚本除外）', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      // `tools/e2e-smoke.mjs` 是唯一例外：冒烟脚本可 import 宿主内部模块（见 plugins.md §三）。
      if (entry.isDirectory()) {
        if (entry.name === 'tools' || entry.name === 'node_modules' || entry.name === 'dist') continue
        walk(path)
      } else if (entry.isFile() && /\.(mjs|ts|js)$/.test(entry.name)) files.push(path)
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
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === 'dist' || entry.name === 'node_modules') continue
        walk(join(dir, entry.name))
        continue
      }
      if (/\.(ts|tsx)$/.test(entry.name) && entry.name !== 'messages.ts') files.push(join(dir, entry.name))
    }
  }
  walk(webDir)
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'))
    assert.ok(!/[\u4e00-\u9fff]/.test(source), `${file} 含散落中文文案`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), `${file} 含硬编码色值`)
  }
})
