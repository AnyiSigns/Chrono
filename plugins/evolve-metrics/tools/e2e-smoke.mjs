// `evolve-metrics` 宿主装配 E2E（**不真跑 cargo 物化**）：
// pack evolve-metrics（残留门面，needs 四个提供方）→ seed → 离线读世界，验证声明
// （identity / implements / methods / needs / pins / start / members）、schema 不再含 `periodic`
// （周期触发随方法迁入 evolve-evidence / evolve-sweep）、`.worldignore` 效果（test/ / target/ /
// tools/ 不入源码树，src/ / execute/ / schema/ / Cargo.toml / Cargo.lock 入树）。
// 说明：本脚本只做离线入世与投影读，**不起宿主**，故不触发 H15 依赖物化（cargo build）。
// 用法：node plugins/evolve-metrics/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const PLUGIN_DIR = join(REPO_ROOT, 'plugins', 'evolve-metrics')

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  const stdout = result.stdout.trim()
  let parsed = null
  if (stdout.length > 0) {
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
  }
  if (result.status !== 0) {
    throw new Error(
      `boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`,
    )
  }
  return parsed
}

/** 沿 tree def 收集 `路径 → blob def 哈希`（tree body = { entries:[{name,mode,hash}] }）。 */
function collectTreePaths(world, treeHash, prefix = '', out = new Map()) {
  const entries = world.defs[treeHash]?.body?.entries ?? []
  for (const entry of entries) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
    if (entry.mode === 'dir') collectTreePaths(world, entry.hash, path, out)
    else out.set(path, entry.hash)
  }
  return out
}

function readBlob(world, hash) {
  const body = world.defs[hash]?.body
  assert.equal(typeof body, 'string', `blob ${hash} 不是文本`)
  return body
}

function latestCodeGen(identity) {
  // 世代 payload 指向 commit def（body.tree 存在即代码世代）；取最后一个。
  return [...identity.gens].reverse().find((gen) => gen.payload !== undefined) ?? null
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-evolve-metrics-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })

  const packed = boot(root, ['pack', PLUGIN_DIR, '--identity', 'evolve-metrics'])
  assert.equal(packed.ok, true, 'pack evolve-metrics 报告 ok:false')
  console.log(`pack evolve-metrics: ${packed.status}`)

  writeFileSync(
    join(root, 'state', 'plugins.json'),
    JSON.stringify([{ name: 'evolve-metrics', path: PLUGIN_DIR }]),
  )
  const seeded = boot(root, ['seed'])
  assert.equal(seeded.ok, true, 'seed 报告 ok:false')
  console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

  const paths = hostPaths(root)
  const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
  const world = anchor.world
  const identity = world.ids['evolve-metrics']
  assert.ok(identity !== undefined, '世界里缺 evolve-metrics 身份')

  // 声明：读世界里入世的 plugin.json blob（证明世界内容，不读本地文件）。
  const gen = latestCodeGen(identity)
  assert.ok(gen !== null, 'evolve-metrics 无可解析代码世代')
  const tree = collectTreePaths(world, world.defs[gen.payload].body.tree)
  const decl = JSON.parse(readBlob(world, tree.get('plugin.json')))
  assert.equal(decl.identity, 'evolve-metrics')
  assert.deepEqual(decl.implements, ['evolve-metrics'])
  assert.deepEqual(decl.methods['evolve-metrics'], ['aggregate', 'sweep', 'shadow', 'record'])
  assert.equal(decl.start, 'node execute/launch.mjs')
  assert.deepEqual(decl.pins, {})
  assert.deepEqual(decl.needs, {
    'evolve-ledger': { mode: 'one' },
    'evolve-evidence': { mode: 'one' },
    'evolve-sweep': { mode: 'one' },
    'evolve-shadow': { mode: 'one' },
  })
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members.map((member) => member.path).sort(), [
    'execute/',
    'schema/',
    'src/',
  ])
  console.log('声明：identity / implements / methods / needs / pins / start / members 就位')

  // schema 不再含 periodic：周期触发随方法迁入 evolve-evidence / evolve-sweep。
  const schema = world.defs[identity.schema].body
  assert.ok(schema.periodic === undefined, '门面 schema 不应再含 periodic')
  // 数值调参不重定义：schema 里不出现聚类阈值字段。
  assert.ok(!JSON.stringify(schema).includes('failure_cluster_n'), 'schema 不应重定义聚类阈值')
  console.log('schema：无 periodic（随方法迁出），不重定义聚类阈值')

  // .worldignore：test/ / target/ / tools/ 不入树；契约必需文件与源码入树。
  const all = [...tree.keys()]
  assert.ok(!all.some((path) => path.startsWith('test/')), `test/ 不应入树：${all}`)
  assert.ok(!all.some((path) => path.startsWith('target/')), `target/ 不应入树：${all}`)
  assert.ok(!all.some((path) => path.startsWith('tools/')), `tools/ 不应入树：${all}`)
  assert.ok(!all.includes('.worldignore'), '.worldignore 自身不应入树')
  for (const required of [
    'plugin.json',
    'package.json',
    'README.md',
    'Cargo.toml',
    'Cargo.lock',
    'schema/evolve-metrics.json',
    'execute/launch.mjs',
    'src/main.rs',
    'src/lib.rs',
    'src/protocol.rs',
    'src/port.rs',
    'src/error.rs',
  ]) {
    assert.ok(all.includes(required), `源码树缺 ${required}（实有：${all.join(', ')}）`)
  }
  console.log(`.worldignore：入树 ${all.length} 个文件，test/ / target/ / tools/ 已排除`)

  console.log(`E2E ok（root=${root}）`)
}

try {
  main()
} catch (err) {
  console.error(err.stack || err.message)
  process.exitCode = 1
}
