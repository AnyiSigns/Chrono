// `todo` 宿主装配 E2E（黑盒，经 boot CLI）：
// 临时 root → pack plugins/todo → state/plugins.json 列 todo → seed → start
// → 轮询 loaded（握手）→ stop → verify + replay → 离线读投影核对身份 / schema / 世代，
// 并核对入世源码树不含 .worldignore 声明的 test/ 与 tools/。
// 用法：node plugins/todo/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const TODO_DIR = join(REPO_ROOT, 'plugins', 'todo')

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

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
}

/** 源码树（commit def → tree def → entries）里是否含某顶层名。 */
function treeHas(world, identityId, name) {
  const identity = world.ids[identityId]
  const gen = [...identity.gens].reverse().find((item) => {
    const def = world.defs[item.payload]
    return def !== undefined && typeof def.body?.tree === 'string'
  })
  assert.ok(gen, '未找到 todo 的代码世代')
  const treeHash = world.defs[gen.payload].body.tree
  const entries = world.defs[treeHash].body.entries
  return entries.some((entry) => entry.name === name)
}

function checkDeclaration() {
  const decl = JSON.parse(readFileSync(join(TODO_DIR, 'plugin.json'), 'utf8'))
  assert.equal(decl.identity, 'todo')
  assert.deepEqual(decl.implements, ['todo'])
  assert.deepEqual(decl.methods, { todo: ['describe', 'invoke'] })
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, 'node execute/main.ts')
  assert.deepEqual(
    decl.members.map((member) => member.kind).sort(),
    ['execute', 'schema'],
  )
  assert.deepEqual(decl.commands, [])
  const ignore = readFileSync(join(TODO_DIR, '.worldignore'), 'utf8')
  assert.match(ignore, /(^|\n)test\/(\r?\n|$)/, '.worldignore 须声明 test/')
  console.log('声明：identity / implements / methods / pins / start / members / commands 与 .worldignore 正确')
}

async function main() {
  checkDeclaration()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-todo-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', TODO_DIR, '--identity', 'todo'])
    assert.equal(packed.ok, true, `pack todo 报告 ok:false`)
    console.log(`pack todo: ${packed.status}`)

    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify([{ name: 'todo', path: TODO_DIR }]))
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'])
      return status.loaded.some((item) => item.id === 'todo')
    }, 'todo loaded')
    console.log('start + 握手：ok（todo 已装载）')

    const status = boot(root, ['status'])
    const loaded = status.loaded.find((item) => item.id === 'todo')
    assert.match(loaded.gen, /^[0-9a-f]{64}$/, 'todo 应有 active 代码世代')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    // 离线读投影：身份 / 世代 / schema；源码树不含 .worldignore 声明项
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const todo = projection.ids.todo
    assert.ok(todo, '投影缺 todo')
    assert.match(todo.active, /^[0-9a-f]{64}$/, 'todo 应有 active 世代')
    assert.ok(todo.gens.length >= 1, 'todo 应有代码世代')
    assert.equal(treeHas(anchor.world, 'todo', 'execute'), true, '源码树缺 execute/')
    assert.equal(treeHas(anchor.world, 'todo', 'schema'), true, '源码树缺 schema/')
    assert.equal(treeHas(anchor.world, 'todo', 'test'), false, '.worldignore 未排除 test/')
    assert.equal(treeHas(anchor.world, 'todo', 'tools'), false, '.worldignore 未排除 tools/')

    const schemaDef = anchor.world.defs[anchor.world.ids.todo.schema]
    assert.ok(schemaDef, '投影缺 todo schema def')
    assert.equal(typeof schemaDef.body.properties.max_items, 'object', 'schema 缺 max_items 声明')
    assert.equal(existsSync(join(TODO_DIR, 'test', 'todo.test.mjs')), true)
    console.log('离线投影：身份 / 世代 / schema / .worldignore 排除正确')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
