// 插件声明守护：`plugin.json` 的 `pins` 只允许保留宿主自身（`host`）。
// 能力类消费一律走 `needs`（`one` / `many`），不再用非 host 的 `pins` 建立跨身份依赖边。
// 扫描只读各 `plugin.json` 文本、不比对外部状态；违规累积后一次性断言，失败时列出全部违规。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const PLUGINS_DIR = join(ROOT, 'plugins')

// 依赖与构建产物不属于插件声明；`dist` 是随世代产物。
const EXCLUDED_DIRS = new Set(['node_modules', 'target', 'dist'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs))
    else if (entry.name === 'plugin.json') out.push(abs)
  }
  return out
}

function toRepoPath(abs) {
  return relative(ROOT, abs).split('\\').join('/')
}

test('插件 pins 只允许 host：非 host 的跨身份依赖一律走 needs', () => {
  const offenders = []
  let scanned = 0
  for (const abs of walk(PLUGINS_DIR)) {
    const repoPath = toRepoPath(abs)
    let decl
    try {
      decl = JSON.parse(readFileSync(abs, 'utf8'))
    } catch (err) {
      offenders.push(`${repoPath}: unparsable plugin.json (${err.message})`)
      continue
    }
    scanned += 1
    const pins = decl.pins
    if (pins === undefined || pins === null) continue
    if (typeof pins !== 'object' || Array.isArray(pins)) {
      offenders.push(`${repoPath}: pins is not an object`)
      continue
    }
    for (const [name, value] of Object.entries(pins)) {
      if (name !== 'host') {
        offenders.push(`${repoPath}: non-host pin "${name}" (use needs instead)`)
        continue
      }
      if (value !== 'host') {
        offenders.push(`${repoPath}: host pin must bind "host", got ${JSON.stringify(value)}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
  // 覆盖兜底：扫描确实触达足量插件声明（防扫描条件写错导致空转）。
  assert.ok(scanned >= 50, `expected >= 50 plugin.json files, got ${scanned}`)
})
