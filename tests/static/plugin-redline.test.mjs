// 插件红线静态扫描：一次覆盖全部插件，而不是给每个插件拷一份自检。
// 规则（docs/plugins.md 做法红线：不 import 宿主与内核、不与其他插件直连）：
//   1. 插件内任何文件（含 execute/ src/ terms/ test/）不得 import 宿主与内核（packages/*）；
//   2. 插件之间不得直连，任何文件不得 import 到兄弟插件的目录；
//   3. 语言中立：Rust 源与 Cargo.toml 里的相对路径同样受检。
// 扫描只读源码文本、不比对外部状态；违规累积后一次性断言，失败时列出全部违规。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const PLUGINS_DIR = join(ROOT, 'plugins')

// 排除目录：依赖与构建产物不属于插件源码；`dist` 是随世代产物（execute/web/dist 等）。
const EXCLUDED_DIRS = new Set(['node_modules', 'target', 'dist'])

// 例外一（按路径模式，见 isExempt）：各插件自带的独立发布自检脚本 `tools/e2e-smoke.mjs`，
// 宿主不装载、不在运行期路径，仅做声明校验。
// 例外二（逐文件登记）：既存跨插件引用，正确落点是根 `tests/contract/`（跨插件测试），
// 相关插件不在本次改动范围内，故登记待迁，不静默跳过。
const ALLOWED_FILES = new Set([
  'plugins/tools/test/net-gate.test.mjs',
])

const JS_EXT = /\.(mjs|cjs|js|ts|tsx|mts|cts)$/
const RUST_EXT = /\.(rs|toml)$/
const JS_IMPORT_RES = [
  /\bfrom\s*(['"])([^'"]+)\1/g,
  /\bimport\s*(['"])([^'"]+)\1/g,
  /\bimport\s*\(\s*(['"])([^'"]+)\1/g,
  /\brequire\s*\(\s*(['"])([^'"]+)\1/g,
]
const QUOTED_RELATIVE_RE = /(['"])(\.\.?\/[^'"]+)\1/g

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(abs))
    else out.push(abs)
  }
  return out
}

function toRepoPath(abs) {
  return relative(ROOT, abs).split('\\').join('/')
}

function isExempt(repoPath) {
  if (ALLOWED_FILES.has(repoPath)) return true
  return /\/tools\/e2e-smoke\.mjs$/.test(repoPath)
}

/** 解析相对 import：返回仓库内路径（未逃出仓库时），否则 null。 */
function resolveRelative(repoPath, spec) {
  const resolved = normalize(join(dirname(repoPath), spec)).split('\\').join('/')
  if (resolved.startsWith('..')) return null
  return resolved
}

/** 判定一条解析结果是否违规；违规返回原因，否则 null。 */
function classify(repoPath, resolved, pluginNames) {
  const selfPlugin = repoPath.split('/')[1]
  if (resolved === 'packages' || resolved.startsWith('packages/')) return 'imports packages/'
  if (resolved.startsWith('plugins/')) {
    const other = resolved.split('/')[1]
    // 只认真正存在的插件目录：`../../etc` 之类落到 plugins/ 下的相对路径属误报。
    if (other !== selfPlugin && pluginNames.has(other)) return `cross-plugin import -> ${other}`
  }
  return null
}

/** 判定一条裸（非相对）说明符是否违规。 */
function classifyBare(spec) {
  if (spec === 'packages' || spec.startsWith('packages/')) return 'imports packages/'
  return null
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length
}

function scanJs(repoPath, src, offenders, pluginNames) {
  for (const re of JS_IMPORT_RES) {
    for (const match of src.matchAll(re)) {
      const spec = match[2]
      let reason = null
      if (spec.startsWith('.')) {
        const resolved = resolveRelative(repoPath, spec)
        if (resolved !== null) reason = classify(repoPath, resolved, pluginNames)
      } else {
        reason = classifyBare(spec)
      }
      if (reason !== null) offenders.push(`${repoPath}:${lineOf(src, match.index)} ${reason}`)
    }
  }
}

function scanRust(repoPath, src, offenders, pluginNames) {
  for (const match of src.matchAll(QUOTED_RELATIVE_RE)) {
    const spec = match[2]
    const resolved = resolveRelative(repoPath, spec)
    if (resolved === null) continue
    const reason = classify(repoPath, resolved, pluginNames)
    if (reason !== null) offenders.push(`${repoPath}:${lineOf(src, match.index)} ${reason}`)
  }
  // `use` 语句里直接写出的 packages/ 或兄弟插件路径（Rust 模块路径不受目录约束，仍需机械拦住）。
  for (const match of src.matchAll(/\buse\s+[^;\n]+/g)) {
    const statement = match[0]
    if (statement.includes('packages/')) {
      const reason = 'imports packages/'
      offenders.push(`${repoPath}:${lineOf(src, match.index)} ${reason}`)
    }
  }
}

test('插件红线：全插件不得 import packages/*，不得跨插件 import（含 Rust 源与 Cargo.toml）', () => {
  const offenders = []
  const pluginNames = new Set(
    readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )
  const files = walk(PLUGINS_DIR)
  let scanned = 0
  for (const abs of files) {
    const repoPath = toRepoPath(abs)
    if (isExempt(repoPath)) continue
    if (JS_EXT.test(repoPath)) {
      scanJs(repoPath, readFileSync(abs, 'utf8'), offenders, pluginNames)
      scanned += 1
    } else if (RUST_EXT.test(repoPath)) {
      scanRust(repoPath, readFileSync(abs, 'utf8'), offenders, pluginNames)
      scanned += 1
    }
  }
  assert.deepEqual(offenders, [])
  // 覆盖兜底：扫描确实触达全部插件目录与足量源文件（防扫描条件写错导致空转）。
  assert.ok(pluginNames.size >= 51, `expected >= 51 plugin dirs, got ${pluginNames.size}`)
  assert.ok(scanned >= 200, `expected >= 200 scanned files, got ${scanned}`)
})
