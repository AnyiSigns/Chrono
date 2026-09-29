// 从各 `plugins/*/plugin.json` 的声明面生成 `docs/plugins-overview.md`（整份生成，勿手改）。
// 角色挂在能力类上：拥有方 `slots`（声明契约）/ 提供方 `implements` / 消费方 `needs`；
// 一个插件跨能力类可同时持有三种角色。输出按插件名字典序，确定（同输入同输出）。
// 各插件「做什么 / 不做什么」看其自带 `README.md`。
// 用法：`node tools/gen-plugins-overview.mjs`（写回）；`node tools/gen-plugins-overview.mjs --check`（只校验，漂移即非零退出）。
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = join(ROOT, 'plugins')
const DOC = join(ROOT, 'docs', 'plugins-overview.md')
const DASH = '—'

/** 收集一个插件目录的声明；无 `plugin.json` 返回 null。 */
function readDecl(dir) {
  let raw
  try {
    raw = JSON.parse(readFileSync(join(PLUGINS, dir, 'plugin.json'), 'utf8'))
  } catch {
    return null
  }
  const keys = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
  const needs = keys(raw.needs).map((cap) => {
    const entry = raw.needs[cap]
    const mode = entry !== null && typeof entry === 'object' ? entry.mode : undefined
    return `${cap}(${typeof mode === 'string' ? mode : 'one'})`
  })
  return {
    name: typeof raw.identity === 'string' ? raw.identity : dir,
    slots: keys(raw.slots),
    implements: Array.isArray(raw.implements) ? raw.implements.filter((item) => typeof item === 'string') : [],
    needs,
    pins: keys(raw.pins),
    state: typeof raw.state === 'string' ? raw.state : 'recomputable',
    transport: typeof raw.transport === 'string' ? raw.transport : 'stdio',
  }
}

function cell(items) {
  return items.length === 0 ? DASH : items.map((item) => `\`${item}\``).join('、')
}

/** 渲染整份 `docs/plugins-overview.md`；`root` 可注入（测试用）。 */
export function renderOverview(root = ROOT) {
  const pluginsDir = join(root, 'plugins')
  const decls = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readDecl(entry.name))
    .filter((decl) => decl !== null)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const rows = decls.map(
    (decl) =>
      `| \`${decl.name}\` | ${cell(decl.slots)} | ${cell(decl.implements)} | ${cell(decl.needs)} | ${cell(
        decl.pins,
      )} | ${decl.state} | ${decl.transport} |`,
  )
  return [
    '# 插件总览',
    '',
    '> 本文件由 `tools/gen-plugins-overview.mjs` 从各 `plugins/*/plugin.json` 的 `slots` / `implements` / `needs` / `pins` 生成，`tests/static/plugins-overview.test.mjs` 守护不漂，**勿手改**。',
    '> 各插件「做什么 / 不做什么」见其自带自述 `README.md`；插件之间不 import、不相识，跨身份依赖只经**能力类**表达。',
    '> 角色挂在能力类上：**拥有方** `slots`（声明契约）/ **提供方** `implements` / **消费方** `needs`。一个插件跨能力类可同时持有三种角色；同一能力类不得既 `implements` 又 `needs`（拥有方可 `implements` 自产自用、或用 `many` 消费自己的扩展点）；无拥有方时契约回落提供方 `methods`。',
    '',
    `共 ${decls.length} 个插件。`,
    '',
    '| 插件 | 拥有 `slots` | 提供 `implements` | 消费 `needs` | 依赖 `pins` | state | transport |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
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
