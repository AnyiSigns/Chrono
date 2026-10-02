// 合并的声明守护：一次扫描全部 `plugins/*/plugin.json`，经唯一解析器（`plugin-sdk/decl.ts`，
// 宿主 `parsePluginDecl` 同源）校验形状 / 字段存在 / 合法性，替代各插件 `test/` 里逐份复述的声明断言。
// 另守护文档字段表与解析器字段表单源：`docs/plugins.md` §二 手写表 / §八 字段清单 / 生成段都不得漂移。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUGIN_DECL_FIELDS, parsePluginDecl } from '../../packages/host/assembly/decl.ts'
import { renderFieldSection } from '../../tools/gen-plugin-fields.mjs'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const PLUGINS_DIR = join(ROOT, 'plugins')
const CANONICAL_NAMES = PLUGIN_DECL_FIELDS.map((field) => field.name)
const REQUIRED_NAMES = PLUGIN_DECL_FIELDS.filter((field) => field.required).map((f) => f.name)

/** 收集 `plugins/<name>/plugin.json` 的绝对路径（按目录名排序）。 */
function declPaths() {
  const out = []
  for (const entry of readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const abs = join(PLUGINS_DIR, entry.name, 'plugin.json')
    if (existsSync(abs)) out.push({ dir: entry.name, abs })
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
}

test('全部 plugins/*/plugin.json 经单解析器通过（形状 / 字段存在 / 合法性）', () => {
  const failures = []
  let scanned = 0
  for (const { dir, abs } of declPaths()) {
    let raw
    try {
      raw = JSON.parse(readFileSync(abs, 'utf8'))
    } catch (err) {
      failures.push(`${dir}: plugin.json 不可解析（${err.message}）`)
      continue
    }
    scanned += 1
    const parsed = parsePluginDecl(raw)
    if (!parsed.ok) {
      failures.push(`${dir}: ${parsed.reasons.join(', ')}`)
      continue
    }
    for (const name of REQUIRED_NAMES) {
      if (!Object.hasOwn(raw, name)) failures.push(`${dir}: 缺必需字段 ${name}`)
    }
    // 可选字段若出现，形状须合法（解析器不消费 concurrent_methods，这里补形态门）
    if (Object.hasOwn(raw, 'concurrent_methods')) {
      const value = raw.concurrent_methods
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((item) => typeof item === 'string' && item.length > 0) ||
        new Set(value).size !== value.length
      ) {
        failures.push(`${dir}: concurrent_methods 须为非空无重复字符串数组`)
      }
    }
  }
  assert.deepEqual(failures, [])
  // 覆盖兜底：确实扫到足量插件声明（防扫描条件写错导致空转）。
  assert.ok(scanned >= 50, `expected >= 50 plugin.json files, got ${scanned}`)
})

test('声明引用的包内路径存在（schema / 命令入口 / 参数 schema / members）', () => {
  const failures = []
  for (const { dir, abs } of declPaths()) {
    const parsed = parsePluginDecl(JSON.parse(readFileSync(abs, 'utf8')))
    if (!parsed.ok) continue // 解析失败由上一测试报出
    const pkgRoot = dirname(abs)
    const declared = []
    if (parsed.decl.schema !== null) declared.push(parsed.decl.schema)
    for (const member of parsed.decl.members) declared.push(member.path)
    for (const command of parsed.decl.commands) {
      declared.push(command.entry)
      if (command.argsSchema !== undefined) declared.push(command.argsSchema)
    }
    for (const rel of declared) {
      if (!existsSync(join(pkgRoot, rel))) failures.push(`${dir}: 声明路径不存在 ${rel}`)
    }
  }
  assert.deepEqual(failures, [])
})

test('start 为空的数据身份使用规范空服务字段（restart / health 空对象，build 空数组）', () => {
  const failures = []
  for (const { dir, abs } of declPaths()) {
    const raw = JSON.parse(readFileSync(abs, 'utf8'))
    if (raw.start !== '') continue
    const restartEmpty = typeof raw.restart === 'object' && raw.restart !== null && Object.keys(raw.restart).length === 0
    const healthEmpty = typeof raw.health === 'object' && raw.health !== null && Object.keys(raw.health).length === 0
    const buildEmpty = Array.isArray(raw.build) && raw.build.length === 0
    if (!restartEmpty) failures.push(`${dir}: start 为空时 restart 应为 {}`)
    if (!healthEmpty) failures.push(`${dir}: start 为空时 health 应为 {}`)
    if (!buildEmpty) failures.push(`${dir}: start 为空时 build 应为 []`)
  }
  assert.deepEqual(failures, [])
})

/** 字段名规范：18 个、必填 10 个。 */
test('字段表规范：字段数与必填数符合不变量', () => {
  assert.equal(CANONICAL_NAMES.length, 18)
  assert.equal(REQUIRED_NAMES.length, 10)
  assert.equal(new Set(CANONICAL_NAMES).size, CANONICAL_NAMES.length)
})

test('docs/plugins.md 生成段与解析器字段表逐字一致', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'plugins.md'), 'utf8')
  assert.ok(
    doc.includes(renderFieldSection()),
    'docs/plugins.md 字段生成段已漂移；请运行 node tools/gen-plugin-fields.mjs',
  )
})

test('docs/plugins.md §二 手写字段表与 §八 字段清单的字段名与单源一致', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'plugins.md'), 'utf8')
  const canonical = [...CANONICAL_NAMES].sort()

  // §二：手写表在「字段（冻结）」到生成段标记之间，取首列反引号字段名。
  const tableStart = doc.indexOf('plugin.json` 字段（冻结）')
  const tableEnd = doc.indexOf('<!-- BEGIN GENERATED: plugin.json fields -->')
  assert.ok(tableStart !== -1 && tableEnd > tableStart, 'docs/plugins.md §二 字段表定位失败')
  const tableText = doc.slice(tableStart, tableEnd)
  const tableNames = [...tableText.matchAll(/^\| `([a-z_]+)` \|/gm)].map((match) => match[1])
  assert.deepEqual([...tableNames].sort(), canonical, '§二 手写字段表字段名与单源不一致')

  // §八：字段清单 bullet 在「18 个字段一个不少：」到首个句号之间。
  const listStart = doc.indexOf('18 个字段一个不少：')
  assert.ok(listStart !== -1, 'docs/plugins.md §八 字段清单定位失败')
  const listEnd = doc.indexOf('。', listStart)
  const listText = doc.slice(listStart, listEnd === -1 ? undefined : listEnd)
  const listNames = [...listText.matchAll(/`([a-z_]+)`/g)].map((match) => match[1])
  assert.deepEqual([...listNames].sort(), canonical, '§八 字段清单字段名与单源不一致')
})
