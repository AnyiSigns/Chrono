// 插件红线静态扫描：一次覆盖全部插件，而不是给每个插件拷一份自检。
// 规则（docs/plugins.md 做法红线：不 import 宿主与内核、不与其他插件直连）：
//   1. 插件运行期源码（含 execute/ src/ terms/ test/）不得 import 宿主与内核（packages/*）；
//   2. 插件之间不得直连，任何运行期文件不得 import 到兄弟插件的目录；
//   3. 语言中立：Rust 源与 Cargo.toml 里的相对路径同样受检。
// 「运行期源码」与「dev / 构建脚本」的分界（口径裁决）：`plugins/<插件>/tools/**` 是
// 不入世的本地 dev / 构建脚本——各插件 `.worldignore` 排除 `tools/`，宿主既不物化也不装载，
// 不经线协议在运行期执行，故允许 import 宿主内部面做本地校验；其余位置（尤其 execute/）都
// 是运行期源码，不得 import packages/*。这里以目录为界而非文件名黑名单：新增 dev 脚本无需改
// 门禁，运行期文件挪进 tools/ 则一并豁免，前提是它已被 `.worldignore` 排除出运行期世界。
// 扫描只读源码文本、不比对外部状态；违规累积后一次性断言，失败时列出全部违规。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const PLUGINS_DIR = join(ROOT, 'plugins')

// 排除目录：依赖与构建产物不属于插件源码；`dist` 是随世代产物（execute/web/dist 等）。
const EXCLUDED_DIRS = new Set(['node_modules', 'target', 'dist'])

// dev / 构建脚本目录：`plugins/<插件>/tools/**`。以目录结构为界，非文件名黑名单。
// 这类文件被各插件 `.worldignore` 排除、宿主不装载，属本地校验工具，不在运行期红线内。
const DEV_TOOL_PATH_RE = /^plugins\/[^/]+\/tools\//

function isDevTool(repoPath) {
  return DEV_TOOL_PATH_RE.test(repoPath)
}

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

const pluginNames = () =>
  new Set(
    readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  )

test('插件红线：运行期源码不得 import packages/*，不得跨插件 import（含 Rust 源与 Cargo.toml）', () => {
  const offenders = []
  const devTools = []
  const names = pluginNames()
  const files = walk(PLUGINS_DIR)
  let scanned = 0
  for (const abs of files) {
    const repoPath = toRepoPath(abs)
    // dev / 构建脚本（plugins/<插件>/tools/**）不在运行期世界内，允许 import 宿主内部面。
    if (isDevTool(repoPath)) {
      devTools.push(repoPath)
      continue
    }
    if (JS_EXT.test(repoPath)) {
      scanJs(repoPath, readFileSync(abs, 'utf8'), offenders, names)
      scanned += 1
    } else if (RUST_EXT.test(repoPath)) {
      scanRust(repoPath, readFileSync(abs, 'utf8'), offenders, names)
      scanned += 1
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `运行期插件源码违反红线（不得 import packages/*、不得跨插件 import）：\n${offenders.join('\n')}`,
  )
  // 覆盖兜底：扫描确实触达全部插件目录与足量运行期源文件（防扫描条件写错导致空转）。
  assert.ok(names.size >= 51, `expected >= 51 plugin dirs, got ${names.size}`)
  assert.ok(scanned >= 200, `expected >= 200 scanned files, got ${scanned}`)
  // dev 脚本豁免覆盖兜底：确实识别到足量 `plugins/<插件>/tools/` 脚本，且豁免路径全在该目录下
  // （防目录判定写错导致豁免失效，或过宽到把运行期文件也放过）。
  assert.ok(devTools.length >= 32, `expected >= 32 dev-tool files, got ${devTools.length}`)
  assert.ok(
    devTools.every((repoPath) => DEV_TOOL_PATH_RE.test(repoPath)),
    'dev 脚本豁免路径必须位于 plugins/<插件>/tools/ 之下',
  )
})

test('红线豁免边界：仅 plugins/<插件>/tools/ 属 dev 脚本，运行期目录不豁免', () => {
  assert.equal(isDevTool('plugins/guard/tools/e2e-smoke.mjs'), true)
  assert.equal(isDevTool('plugins/guard/tools/nested/helper.mjs'), true)
  assert.equal(isDevTool('plugins/tools/tools/helper.mjs'), true)
  assert.equal(isDevTool('plugins/guard/execute/main.ts'), false)
  // 插件名恰好为 tools 时，其运行期 execute/ 仍不得豁免。
  assert.equal(isDevTool('plugins/tools/execute/main.ts'), false)
  assert.equal(isDevTool('plugins/guard/test/package.test.mjs'), false)
  assert.equal(isDevTool('plugins/guard/src/terms/foo.ts'), false)
  assert.equal(isDevTool('packages/host/paths.ts'), false)
})

test('dev 脚本豁免的前提：凡有 tools/ 的插件，.worldignore 必须排除 tools/', () => {
  // 豁免的语义前提是 tools/ 不入世（宿主不物化、不装载）。若某插件忘了排除，tools/ 里的脚本
  // 会随包入世、可能被当运行期内容，豁免就不再成立——这里把它钉死，堵住「往 tools/ 塞运行期
  // 代码以绕过红线」的路径。
  const missing = []
  for (const name of pluginNames()) {
    const toolsDir = join(PLUGINS_DIR, name, 'tools')
    if (!existsSync(toolsDir)) continue
    const ignoreFile = join(PLUGINS_DIR, name, '.worldignore')
    const lines = existsSync(ignoreFile)
      ? readFileSync(ignoreFile, 'utf8')
          .split(/\r?\n/)
          .map((line) => line.trim())
      : []
    if (!lines.some((line) => line === 'tools' || line === 'tools/')) missing.push(name)
  }
  assert.deepEqual(
    missing,
    [],
    `以下插件有 tools/ 目录却未在 .worldignore 排除它（dev 豁免前提不成立）：${missing.join(', ')}`,
  )
})
