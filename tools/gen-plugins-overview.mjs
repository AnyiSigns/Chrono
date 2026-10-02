// 从各 `plugins/*/plugin.json` 的声明面生成 `docs/plugins-overview.md`（整份生成，勿手改）。
// 声明经唯一解析器 `plugin-sdk/decl.ts`（宿主 `parsePluginDecl` 同源）解析，字段口径不在此复述。
// 角色挂在能力类上：拥有方 `slots`（声明契约）/ 提供方 `implements` / 消费方 `needs`；
// 一个插件跨能力类可同时持有三种角色。输出按插件名字典序，确定（同输入同输出）。
// 各插件「做什么 / 不做什么」看其自带 `README.md`。
// 用法：`node tools/gen-plugins-overview.mjs`（写回）；`node tools/gen-plugins-overview.mjs --check`（只校验，漂移即非零退出）。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parsePluginDecl } from '../packages/host/assembly/decl.ts'
import { PLUGIN_DECL_FIELDS } from '../plugin-sdk/decl.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = join(ROOT, 'plugins')
const DOC = join(ROOT, 'docs', 'plugins-overview.md')
const DASH = '—'

/** 读一个插件目录的原始声明文本；无 `plugin.json` 返回 null。 */
function readRaw(dir) {
  try {
    return JSON.parse(readFileSync(join(PLUGINS, dir, 'plugin.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 转义 markdown 表格分隔符与换行，避免值破坏行结构。 */
function esc(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function jsonCell(value) {
  return esc(JSON.stringify(value))
}

function listCell(items) {
  return items.length === 0 ? DASH : items.map((item) => `\`${esc(item)}\``).join('、')
}

function mapCell(entries) {
  return entries.length === 0
    ? DASH
    : entries.map(([key, text]) => `\`${esc(key)}\`→${text}`).join('、')
}

/**
 * 读一个插件目录并解析声明；返回总览所需的全部字段视图。
 * 声明不可解析（`ok:false`）抛出：生成物必须建立在合法声明之上，坏声明交 plugin-decl 守护报出。
 */
function readDecl(dir) {
  const raw = readRaw(dir)
  if (raw === null) return null
  const parsed = parsePluginDecl(raw)
  if (!parsed.ok) {
    throw new Error(`plugins/${dir}/plugin.json 解析失败：${parsed.reasons.join(', ')}`)
  }
  const decl = parsed.decl
  const hasService = decl.members.some((member) => member.kind === 'execute')
  const concurrent = Array.isArray(raw.concurrent_methods)
    ? raw.concurrent_methods.filter((item) => typeof item === 'string')
    : []
  return {
    name: decl.identity,
    raw,
    decl,
    hasService,
    concurrent,
  }
}

/** 字段 → 该插件的展示值；覆盖 `PLUGIN_DECL_FIELDS` 全部字段（含可选 / 缺省）。 */
function fieldValue(entry, fieldName) {
  const { decl, raw, hasService, concurrent } = entry
  switch (fieldName) {
    case 'identity':
      return `\`${esc(decl.identity)}\``
    case 'schema':
      return decl.schema === null ? DASH : `\`${esc(decl.schema)}\``
    case 'implements':
      return listCell(decl.implements)
    case 'methods':
      return mapCell(
        Object.keys(decl.methods)
          .sort()
          .map((cap) => [cap, listCell(decl.methods[cap])]),
      )
    case 'concurrent_methods':
      return listCell(concurrent)
    case 'needs':
      return mapCell(
        Object.keys(decl.needs)
          .sort()
          .map((cap) => [cap, `(${decl.needs[cap].mode})`]),
      )
    case 'slots':
      return mapCell(
        Object.keys(decl.slots)
          .sort()
          .map((cap) => [cap, listCell(decl.slots[cap].methods)]),
      )
    case 'judgments':
      return mapCell(
        Object.keys(decl.judgments)
          .sort()
          .flatMap((cap) =>
            Object.keys(decl.judgments[cap])
              .sort()
              .map((method) => [`${cap}.${method}`, `\`${esc(decl.judgments[cap][method])}\``]),
          ),
      )
    case 'start':
      return `\`${esc(decl.start)}\``
    case 'transport':
      // 无执行件的身份不起服务（数据身份），传输形态不适用
      return hasService ? `\`${esc(decl.transport)}\`` : DASH
    case 'build':
      return decl.build.length === 0
        ? '`[]`'
        : decl.build
            .map((step) => `\`${esc([step.cmd, ...step.args].join(' '))}\``)
            .join('、')
    case 'exclusive':
      return listCell(decl.exclusive)
    case 'protocol':
      return `\`${esc(decl.protocol)}\``
    case 'restart':
      return `\`${jsonCell(decl.restart)}\``
    case 'health':
      return `\`${jsonCell(decl.health)}\``
    case 'state':
      return `\`${esc(decl.state)}\``
    case 'members':
      return listCell(decl.members.map((member) => `${member.kind}:${member.path}`))
    case 'commands': {
      const names = decl.commands.map((command) =>
        command.readonly ? `${command.name}(ro)` : command.name,
      )
      return listCell(names)
    }
    default:
      // raw 里可能存在解析器不消费的保留字段（如 concurrent_methods 已单列），统一从 raw 兜底。
      return Object.hasOwn(raw, fieldName) ? `\`${jsonCell(raw[fieldName])}\`` : DASH
  }
}

/** 渲染整份 `docs/plugins-overview.md`；`root` 可注入（测试用）。 */
export function renderOverview(root = ROOT) {
  const pluginsDir = join(root, 'plugins')
  const decls = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readDecl(entry.name))
    .filter((decl) => decl !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const summaryRows = decls.map(
    (entry) =>
      `| \`${entry.name}\` | ${listCell(Object.keys(entry.decl.slots).sort())} | ${listCell(
        entry.decl.implements,
      )} | ${mapCell(
        Object.keys(entry.decl.needs)
          .sort()
          .map((cap) => [cap, `(${entry.decl.needs[cap].mode})`]),
      )} | ${esc(entry.decl.state)} | ${entry.hasService ? `\`${esc(entry.decl.transport)}\`` : DASH} |`,
  )

  const detail = decls.flatMap((entry) => [
    `### \`${entry.name}\``,
    '',
    ...PLUGIN_DECL_FIELDS.map(
      (field) => `- \`${field.name}\`: ${fieldValue(entry, field.name)}`,
    ),
    '',
  ])

  return [
    '# 插件总览',
    '',
    '> 本文件由 `tools/gen-plugins-overview.mjs` 从各 `plugins/*/plugin.json` 经唯一解析器 `plugin-sdk/decl.ts` 生成，`tests/static/plugins-overview.test.mjs` 守护不漂，**勿手改**。',
    '> 各插件「做什么 / 不做什么」见其自带自述 `README.md`；插件之间不 import、不相识，跨身份依赖只经**能力类**表达。',
    '> 角色挂在能力类上：**拥有方** `slots`（声明契约）/ **提供方** `implements` / **消费方** `needs`。一个插件跨能力类可同时持有三种角色；同一能力类不得既 `implements` 又 `needs`（拥有方可 `implements` 自产自用、或用 `many` 消费自己的扩展点）；无拥有方时契约回落提供方 `methods`。',
    '',
    `共 ${decls.length} 个插件。`,
    '',
    '## 角色总览',
    '',
    '| 插件 | 拥有 `slots` | 提供 `implements` | 消费 `needs` | state | transport |',
    '| --- | --- | --- | --- | --- | --- |',
    ...summaryRows,
    '',
    '## 全字段明细',
    '',
    '逐插件列出 `plugin.json` 的全部字段（`' +
      PLUGIN_DECL_FIELDS.map((field) => field.name).join('` / `') +
      '`）；省略 / 缺省字段记 `' +
      DASH +
      '`。',
    '',
    ...detail,
  ].join('\n')
}

function main() {
  const check = process.argv.includes('--check')
  const expected = renderOverview(ROOT)
  if (check) {
    let current = ''
    try {
      current = readFileSync(DOC, 'utf8')
    } catch {
      process.stderr.write('缺少 docs/plugins-overview.md：请运行 node tools/gen-plugins-overview.mjs\n')
      process.exit(1)
    }
    if (current !== expected) {
      process.stderr.write('docs/plugins-overview.md 与 plugin.json 声明不一致：请运行 node tools/gen-plugins-overview.mjs\n')
      process.exit(1)
    }
    process.stdout.write('plugins-overview 一致\n')
    return
  }
  writeFileSync(DOC, expected, 'utf8')
  process.stdout.write('plugins-overview 已生成\n')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
