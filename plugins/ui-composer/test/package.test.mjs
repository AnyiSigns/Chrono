// 包形状测试：零 schema、members = execute、pins 空、命令空、`.worldignore`、
// README 守卫、无宿主 / 内核 import、web 层无散落中文与硬编码色值。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
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
  assert.equal(decl.identity, 'ui-composer')
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(decl.protocol, '1')
  assert.equal(decl.state, 'recomputable')
})

test('能力类为 ui-composer（ping 占位）；pins 空；无命令', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(decl.implements, ['ui-composer'])
  assert.deepEqual(decl.methods, { 'ui-composer': ['ping'] })
  assert.deepEqual(decl.pins, {})
  assert.deepEqual(decl.commands, [])
  assert.deepEqual(decl.members, [{ kind: 'execute', path: 'execute/' }])
  assert.equal(decl.health.probe, 'ui-composer.ping')
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

test('插件源码与测试不 import 宿主 / 内核 / 客户端（tools/ 冒烟脚本除外）', () => {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'tools') walk(path)
      else if (entry.isFile() && /\.(mjs|ts|js|json)$/.test(entry.name)) files.push(path)
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
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
        index += 1
      index += 2
      continue
    }
    out += ch
    index += 1
  }
  return out
}

test('web 层代码无散落中文（文案集中在 messages.js）与硬编码色值', () => {
  const webDir = join(pkgRoot, 'execute', 'web')
  for (const name of readdirSync(webDir)) {
    if (!name.endsWith('.js') || name === 'messages.js') continue
    const source = stripComments(readFileSync(join(webDir, name), 'utf8'))
    assert.ok(!/[\u4e00-\u9fff]/.test(source), `${name} 含散落中文文案`)
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(source), `${name} 含硬编码色值`)
  }
})

test('entry.js 导出 mount 且返回 unmount（模块可导入）', async () => {
  const web = join(pkgRoot, 'execute', 'web')
  const module = await import(pathToFileURL(join(web, 'entry.js')).href)
  assert.equal(module.contract, '1')
  assert.equal(typeof module.mount, 'function')
  assert.ok(module.mount.length >= 2)
})
