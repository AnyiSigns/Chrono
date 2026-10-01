// 从解析器单一真源 `plugin-sdk/decl.ts` 的 `PLUGIN_DECL_FIELDS` 生成 `docs/plugins.md` 里的
// `plugin.json` 字段权威清单段（标记之间整段替换）。字段名 / 必填性只有一处手写定义，文档由此派生。
// 用法：`node tools/gen-plugin-fields.mjs`（写回）；`node tools/gen-plugin-fields.mjs --check`（只校验，漂移即非零退出）。
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PLUGIN_DECL_FIELDS } from '../plugin-sdk/decl.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DOC = join(ROOT, 'docs', 'plugins.md')
const BEGIN = '<!-- BEGIN GENERATED: plugin.json fields -->'
const END = '<!-- END GENERATED: plugin.json fields -->'

/** 渲染字段权威清单段（含首尾标记）。 */
export function renderFieldSection() {
  const required = PLUGIN_DECL_FIELDS.filter((field) => field.required).length
  const rows = PLUGIN_DECL_FIELDS.map(
    (field) => `| \`${field.name}\` | ${field.required ? '必填' : '可省略'} | ${field.summary} |`,
  )
  return [
    BEGIN,
    '`plugin.json` 字段的权威清单（名称 / 必填性）由解析器 `plugin-sdk/decl.ts` 单点定义，下表由它生成，**勿手改**：',
    '',
    '| 字段 | 必填性 | 说明 |',
    '| --- | --- | --- |',
    ...rows,
    '',
    `共 ${PLUGIN_DECL_FIELDS.length} 个字段：必填 ${required} 个、可省略 ${PLUGIN_DECL_FIELDS.length - required} 个。`,
    END,
  ].join('\n')
}

/** 把生成段替换进 `docs/plugins.md`；缺标记报错（不猜测插入点）。 */
export function spliceFieldSection(text) {
  const start = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`docs/plugins.md 缺少字段生成标记 ${BEGIN} / ${END}`)
  }
  return text.slice(0, start) + renderFieldSection() + text.slice(end + END.length)
}

function main() {
  const check = process.argv.includes('--check')
  const current = readFileSync(DOC, 'utf8')
  const expected = spliceFieldSection(current)
  if (check) {
    if (current !== expected) {
      process.stderr.write('docs/plugins.md 字段段与解析器字段表不一致：请运行 node tools/gen-plugin-fields.mjs\n')
      process.exit(1)
    }
    process.stdout.write('plugin fields 一致\n')
    return
  }
  if (current === expected) {
    process.stdout.write('plugin fields 已是最新\n')
    return
  }
  writeFileSync(DOC, expected, 'utf8')
  process.stdout.write('plugin fields 已生成\n')
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) main()
