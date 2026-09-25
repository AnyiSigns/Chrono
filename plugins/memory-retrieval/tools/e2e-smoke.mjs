// `memory-retrieval` 宿主装配 E2E（**不真跑 cargo 物化**）：
// 按 pins 拓扑序 pack embedding / secrets / memory-store / model-protocol / memory-retrieval，
// 再 seed，离线读世界验证声明（identity / implements / methods / pins / start / members）、
// pins 解析（名 → 被依赖身份 active 世代哈希）与 `.worldignore` 效果
// （test/ / target/ / tools/ 不入源码树，src/ / execute/ / schema/ / Cargo.toml / Cargo.lock 入树）。
// 说明：本脚本只做离线入世与投影读，**不起宿主**，故不触发宿主侧依赖物化（cargo build）。
// 用法：node plugins/memory-retrieval/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'
import { getBlob, isBlobPointer } from '../../../packages/host/blobs.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

/** pins 拓扑序：被依赖者先入世（memory-store 依赖 embedding；model-protocol 依赖 secrets / config）。 */
const PACK_ORDER = ['embedding', 'secrets', 'config', 'memory-store', 'model-protocol', 'memory-retrieval']

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
    throw new Error(`boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`)
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

/** 读源码文件文本：链上 pointer def → CAS 字节（源码已外迁 `state/blobs/`）。 */
function readBlob(world, hash, blobsDir) {
  const pointer = world.defs[hash]?.body
  assert.ok(isBlobPointer(pointer), `blob ${hash} 不是 pointer def`)
  const result = getBlob(blobsDir, pointer)
  assert.equal(result.ok, true, `blob ${hash} 读取失败`)
  return result.bytes.toString('utf8')
}

function latestCodeGen(identity) {
  // 世代 payload 指向 commit def（body.tree 存在即代码世代）；取最后一个。
  return [...identity.gens].reverse().find((gen) => gen.payload !== undefined) ?? null
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-memory-retrieval-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })

  const plugins = PACK_ORDER.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) }))
  for (const name of PACK_ORDER) {
    const packed = boot(root, ['pack', join(REPO_ROOT, 'plugins', name), '--identity', name])
    assert.equal(packed.ok, true, `pack ${name} 报告 ok:false`)
    console.log(`pack ${name}: ${packed.status}`)
  }

  writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify(plugins))
  const seeded = boot(root, ['seed'])
  assert.equal(seeded.ok, true, 'seed 报告 ok:false')
  console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

  const paths = hostPaths(root)
  const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
  const world = anchor.world
  const identity = world.ids['memory-retrieval']
  assert.ok(identity !== undefined, '世界里缺 memory-retrieval 身份')

  // 声明：读世界里入世的 plugin.json blob（证明世界内容，不读本地文件）。
  const gen = latestCodeGen(identity)
  assert.ok(gen !== null, 'memory-retrieval 无可解析代码世代')
  const tree = collectTreePaths(world, world.defs[gen.payload].body.tree)
  const decl = JSON.parse(readBlob(world, tree.get('plugin.json'), paths.blobsDir))
  assert.equal(decl.identity, 'memory-retrieval')
  assert.deepEqual(decl.implements, ['retrieval'])
  assert.deepEqual(decl.methods.retrieval, ['search'])
  assert.equal(decl.start, 'node execute/launch.mjs')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.pins, {
    embedding: 'embedding',
    memory: 'memory-store',
    model: 'model-protocol',
  })
  assert.deepEqual(
    decl.members.map((member) => member.path).sort(),
    ['execute/', 'schema/', 'src/'],
  )
  console.log('声明：identity / implements / methods / start / members 就位')

  // pins 解析：名 → 被依赖身份 active 世代 payload 哈希（不是字面身份名）。
  for (const [name, dependency] of Object.entries(decl.pins)) {
    const resolved = gen.pins[name]
    assert.ok(isHex64(resolved), `pins.${name} 未解析成 64 位 hex：${resolved}`)
    assert.notEqual(resolved, dependency, `pins.${name} 仍是字面身份名`)
    assert.equal(resolved, world.ids[dependency].active, `pins.${name} != ${dependency}.active`)
  }
  console.log('pins：embedding / memory / model 解析到被依赖身份 active 世代哈希')

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
    'schema/retrieval.json',
    'execute/launch.mjs',
    'src/main.rs',
    'src/lib.rs',
    'src/protocol.rs',
    'src/retrieve.rs',
    'src/vector.rs',
    'src/decay.rs',
    'src/config.rs',
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
