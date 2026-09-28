// 根测试编排：分层、失败即停（可关），不引入根 workspace（各包各自安装，见 packages/README.md）。
// 层序：static（静态扫描）→ drift（契约生成物漂移）→ packages（四个载体包 + plugin-sdk + toolchain）
// → plugins（每个带 package.json 的插件）→ contract（根接缝契约测试）→ e2e（端到端，显式开启）。
// 本脚本只编排，不做安装；缺 node_modules 的条目报 unavailable 并计入该层失败。
// 用法：node tools/test-all.mjs [--layer=<名>]... [--rust] [--e2e] [--list] [--no-bail]

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const ALL_LAYERS = ['static', 'drift', 'packages', 'plugins', 'contract', 'e2e']

/** 载体包（层 `packages`）：各自 `npm test`，均为 vitest。 */
const CARRIER_PACKAGES = [
  'packages/kernel',
  'packages/host',
  'packages/client',
  'packages/boot',
  'plugin-sdk',
  'toolchain',
]

function parseArgs(argv) {
  const options = { layers: [], rust: false, e2e: false, list: false, bail: true }
  for (const arg of argv) {
    if (arg.startsWith('--layer=')) {
      for (const name of arg.slice('--layer='.length).split(',')) {
        const trimmed = name.trim()
        if (trimmed.length > 0 && !options.layers.includes(trimmed)) options.layers.push(trimmed)
      }
    } else if (arg === '--rust') options.rust = true
    else if (arg === '--e2e') options.e2e = true
    else if (arg === '--list') options.list = true
    else if (arg === '--bail') options.bail = true
    else if (arg === '--no-bail') options.bail = false
  }
  return options
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 该目录的测试是否需要本地 node_modules：脚本用 vitest，或声明了依赖。 */
function needsLocalNodeModules(pkgDir) {
  const manifest = readJson(join(pkgDir, 'package.json'))
  const scripts = manifest.scripts ?? {}
  const usesVitest = Object.values(scripts).some((value) => String(value).includes('vitest'))
  const deps = Object.keys(manifest.dependencies ?? {}).length
  const devDeps = Object.keys(manifest.devDependencies ?? {}).length
  return usesVitest || deps > 0 || devDeps > 0
}

const TEST_FILE_RE = /\.test\.(mjs|cjs|js|ts|mts|cts)$/

/** 递归收集目录里的测试文件（Node 24 的 `node --test <目录>` 在本机不可用，改为显式文件列表）。 */
function collectNodeTests(dir) {
  if (!existsSync(dir)) return []
  const out = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'target') continue
      const abs = join(current, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (TEST_FILE_RE.test(entry.name)) out.push(abs)
    }
  }
  out.sort()
  return out
}

/** 列出 plugins/* 里带 package.json 的目录名（字典序）。 */
function pluginDirs() {
  const base = join(ROOT, 'plugins')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((name) => existsSync(join(base, name, 'package.json')))
    .sort()
}

/** 构造一个条目的执行函数与元信息；不实际执行。 */
function entry(layer, target, options) {
  return { layer, target, kind: 'run', ...options }
}

function skipped(layer, target, note) {
  return { layer, target, kind: 'skip', note }
}

/** 每层返回条目数组：`{layer, target, kind:'run'|'skip', command?, args?, cwd?, note?}`。 */
function planNodeDir(layer, target, dir, extraArgs = []) {
  const files = collectNodeTests(join(ROOT, dir))
  if (files.length === 0) return [skipped(layer, target, 'no test files')]
  return [entry(layer, target, { command: process.execPath, args: ['--test', ...extraArgs, ...files] })]
}

function planStatic() {
  return planNodeDir('static', 'tests/static', join('tests', 'static'))
}

function planDrift() {
  const tool = join(ROOT, 'chain-contract', 'tools', 'check-drift.mjs')
  if (!existsSync(tool)) return [skipped('drift', 'chain-contract/tools/check-drift.mjs', 'tool not present')]
  return [entry('drift', 'chain-contract/tools/check-drift.mjs', { command: process.execPath, args: [tool] })]
}

/** npm 条目：整条命令交给 shell（Windows 上是 npm.cmd）。 */
function npmEntry(layer, target, cwd) {
  return entry(layer, target, { command: 'npm test', cwd, shell: true })
}

function npmRunEntry(layer, target, cwd, script) {
  return entry(layer, target, { command: `npm run ${script}`, cwd, shell: true })
}

function planPackages() {
  const entries = []
  for (const pkg of CARRIER_PACKAGES) {
    const dir = join(ROOT, pkg)
    if (!existsSync(dir)) {
      entries.push(skipped('packages', pkg, 'package not present'))
      continue
    }
    if (needsLocalNodeModules(dir) && !existsSync(join(dir, 'node_modules'))) {
      entries.push({
        layer: 'packages',
        target: pkg,
        kind: 'unavailable',
        note: `node_modules missing; run: cd ${pkg} && npm ci`,
      })
      continue
    }
    entries.push(npmEntry('packages', pkg, pkg))
  }
  return entries
}

function planPlugins(options) {
  const entries = []
  for (const name of pluginDirs()) {
    const dir = join(ROOT, 'plugins', name)
    const scripts = readJson(join(dir, 'package.json')).scripts ?? {}
    const testScript = typeof scripts.test === 'string' ? scripts.test : null
    const rustScript = typeof scripts['test:rust'] === 'string' ? scripts['test:rust'] : null
    if (testScript === null && rustScript === null) {
      entries.push(skipped('plugins', `plugins/${name}`, 'no test script'))
      continue
    }
    if (needsLocalNodeModules(dir) && !existsSync(join(dir, 'node_modules'))) {
      entries.push({
        layer: 'plugins',
        target: `plugins/${name}`,
        kind: 'unavailable',
        note: `node_modules missing; run: cd plugins/${name} && npm ci`,
      })
      continue
    }
    const isRustOnly = testScript !== null && testScript.includes('cargo')
    if (isRustOnly) {
      if (options.rust) entries.push(npmEntry('plugins', `plugins/${name} [rust]`, `plugins/${name}`))
      else entries.push(skipped('plugins', `plugins/${name} [rust]`, 'rust gated behind --rust'))
    } else if (testScript !== null) {
      entries.push(npmEntry('plugins', `plugins/${name}`, `plugins/${name}`))
    }
    if (rustScript !== null && !isRustOnly) {
      if (options.rust) entries.push(npmRunEntry('plugins', `plugins/${name} [rust]`, `plugins/${name}`, 'test:rust'))
      else entries.push(skipped('plugins', `plugins/${name} [rust]`, 'rust gated behind --rust'))
    }
  }
  return entries
}

function planContract() {
  return planNodeDir('contract', 'tests/contract', join('tests', 'contract'))
}

function planE2e(options) {
  if (!options.e2e) return [skipped('e2e', 'tests/e2e', 'opt-in behind --e2e')]
  // 每个 e2e 文件都会起一整个真实宿主 + 完整插件闭包，node 默认并行跑文件会把机器压满，
  // 使最慢的场景撞上各自的等待上限而被误判为失败。本层串行执行。
  return planNodeDir('e2e', 'tests/e2e', join('tests', 'e2e'), ['--test-concurrency=1'])
}

function planLayer(layer, options) {
  switch (layer) {
    case 'static':
      return planStatic()
    case 'drift':
      return planDrift()
    case 'packages':
      return planPackages()
    case 'plugins':
      return planPlugins(options)
    case 'contract':
      return planContract()
    case 'e2e':
      return planE2e(options)
    default:
      return [skipped(layer, layer, 'unknown layer')]
  }
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

function runEntry(item) {
  const args = item.args ?? []
  const started = Date.now()
  const result = spawnSync(item.command, args, {
    cwd: item.cwd ? join(ROOT, item.cwd) : ROOT,
    stdio: 'inherit',
    shell: item.shell === true,
  })
  const elapsedMs = Date.now() - started
  const failed = result.status !== 0 || result.error !== undefined
  return { status: failed ? 'fail' : 'pass', elapsedMs, note: failed && result.error ? String(result.error.message) : '' }
}

function printList(options) {
  const selected = options.layers.length > 0 ? options.layers : ALL_LAYERS
  for (const layer of ALL_LAYERS) {
    if (!selected.includes(layer)) continue
    console.log(`[${layer}]`)
    for (const item of planLayer(layer, options)) {
      const state = item.kind === 'run' ? 'run' : item.kind
      console.log(`  ${state.padEnd(11)} ${item.target}${item.note ? `  (${item.note})` : ''}`)
    }
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.list) {
    printList(options)
    return 0
  }
  const invalid = options.layers.filter((name) => !ALL_LAYERS.includes(name))
  if (invalid.length > 0) {
    console.error(`unknown layer(s): ${invalid.join(', ')}; known: ${ALL_LAYERS.join(', ')}`)
    return 1
  }
  const selected = options.layers.length > 0 ? ALL_LAYERS.filter((name) => options.layers.includes(name)) : ALL_LAYERS

  let failedAny = false
  for (const layer of selected) {
    const items = planLayer(layer, options)
    const summary = { pass: 0, fail: 0, skip: 0 }
    const started = Date.now()
    console.log(`\n=== layer ${layer} ===`)
    for (const item of items) {
      if (item.kind === 'skip') {
        summary.skip += 1
        console.log(`  skip        ${item.target}${item.note ? `  (${item.note})` : ''}`)
        continue
      }
      if (item.kind === 'unavailable') {
        summary.fail += 1
        failedAny = true
        console.log(`  UNAVAILABLE ${item.target}  (${item.note})`)
        continue
      }
      const outcome = runEntry(item)
      summary[outcome.status] += 1
      if (outcome.status === 'fail') failedAny = true
      const detail = outcome.note ? `  (${outcome.note})` : ''
      console.log(`  ${outcome.status.padEnd(11)} ${item.target}  ${formatMs(outcome.elapsedMs)}${detail}`)
    }
    const layerMs = Date.now() - started
    console.log(
      `  -- ${layer}: pass=${summary.pass} fail=${summary.fail} skip=${summary.skip} elapsed=${formatMs(layerMs)}`,
    )
    if (failedAny && options.bail) {
      console.log(`\nbail: layer ${layer} failed; stopping before remaining layers`)
      break
    }
  }
  console.log(failedAny ? '\ntest-all: FAIL' : '\ntest-all: PASS')
  return failedAny ? 1 : 0
}

process.exitCode = main()
