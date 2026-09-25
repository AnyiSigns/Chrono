// chat 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读，不 start 宿主）：
// pack chat 及其 pins 闭包（含 #33 loop-policy 及其全部 pins 传递依赖，按拓扑序）
// → seed → 离线读投影确认身份在册、chat 声明 / pins 解析（含 loop-policy）、命令入口解析
// （chat.send / chat.history / chat.resume）、H21 自能力入口 term、.worldignore 生效
// → 声明门禁负例（身份不一致）→ verify。
// 说明：**不执行 `boot start`**——闭包里含 Rust 服务（sandbox / embedding / memory-retrieval /
// evolve-metrics / tool-fs），物化需 cargo build，与本次「声明 / pins / 命令 / .worldignore 就位」
// 验收无关；pack / seed 已覆盖宿主门禁。
// 用法：node plugins/chat/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'
import { listCommands, readPluginDecl, resolveTreeEntry } from '../../../packages/host/assembly/decl.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')

// 拓扑序：被依赖者先 pack（pins 解析要求目标身份已在世界里）。chat 的 pins 闭包含 #33 loop-policy，
// 故按 loop-policy 的 pins 闭包一并 pack，最后补 session-title 与 chat。
const PLUGIN_ORDER = [
  'secrets',
  'sandbox',
  'embedding',
  'model-protocol',
  'input',
  'session',
  'context-window',
  'guard',
  'approval',
  'router',
  'orchestration-admin',
  'todo',
  'question',
  'memory-store',
  'compress',
  'memory-retrieval',
  'memory-consolidate',
  'tool-fs',
  'tool-shell',
  'tool-http',
  'tool-browser',
  'mcp',
  'plugin-admin',
  'evolve-metrics',
  'tools',
  'loop-policy',
  'session-title',
  'chat',
]

const EXPECTED_PINS = {
  session: 'session',
  input: 'input',
  model: 'model-protocol',
  context: 'context-window',
  'session-title': 'session-title',
  'loop-policy': 'loop-policy',
  host: 'host',
}

const EXPECTED_TERMS = {
  'chat.send': ['eff', 'chat', 'send', ['g', ['ids']]],
  'chat.history': ['eff', 'chat', 'history', ['v', 0]],
  'chat.resume': ['eff', 'chat', 'resume', ['v', 0]],
}

function bootRaw(root, args) {
  return spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
}

function boot(root, args) {
  const result = bootRaw(root, args)
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

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-chat-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })

  for (const identity of PLUGIN_ORDER) {
    const dir = join(REPO_ROOT, 'plugins', identity)
    const packed = boot(root, ['pack', dir, '--identity', identity])
    assert.equal(packed.ok, true, `pack ${identity} 报告 ok:false：${JSON.stringify(packed)}`)
  }
  console.log(`pack: ${PLUGIN_ORDER.length} 身份（chat pins 闭包含 loop-policy）`)

  writeFileSync(
    join(root, 'state', 'plugins.json'),
    JSON.stringify(PLUGIN_ORDER.map((identity) => ({ name: identity, path: join(REPO_ROOT, 'plugins', identity) }))),
  )

  const seeded = boot(root, ['seed'])
  assert.equal(seeded.ok, true, 'seed 报告 ok:false')
  assert.equal(seeded.items.length, PLUGIN_ORDER.length, 'seed 应覆盖全部身份')
  console.log(`seed: ${seeded.items.length} 身份`)

  const paths = hostPaths(root)
  const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
  const projection = projectBaseOnly(anchor.world, anchor.head, { blobsDir: paths.blobsDir })
  for (const identity of PLUGIN_ORDER) {
    assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
  }
  assert.deepEqual(projection.ids['chat'].pins, EXPECTED_PINS, 'chat pins 应解析为身份名（含 loop-policy）')
  for (const target of Object.values(EXPECTED_PINS)) {
    if (target === 'host') continue
    assert.ok(projection.ids[target], `pins 目标缺身份 ${target}`)
  }
  console.log('离线投影：chat pins 五项（含 loop-policy）解析通过')

  // 声明：execute + term + schema；implements / methods / start 就位
  const decl = readPluginDecl(anchor.world, 'chat', paths.blobsDir)
  assert.ok(decl !== null, 'chat 声明应可解析')
  assert.equal(decl.decl.identity, 'chat')
  assert.deepEqual(decl.decl.implements, ['chat'])
  assert.deepEqual(decl.decl.methods.chat, ['send', 'history', 'resume'])
  assert.equal(decl.decl.start, 'node execute/main.ts')
  assert.deepEqual(
    decl.decl.members,
    [
      { kind: 'execute', path: 'execute/' },
      { kind: 'term', path: 'terms/' },
      { kind: 'schema', path: 'schema/' },
    ],
    'chat 成员 = execute + term + schema',
  )
  console.log('声明：implements/methods（含 resume）/start/members 通过')

  // 命令入口可解析（宿主按声明解析到 def 哈希），入口 term 是 H21 自能力 eff
  const commands = listCommands(anchor.world, paths.blobsDir).filter((command) => command.identity === 'chat')
  assert.deepEqual(
    commands.map((command) => command.name).sort(),
    ['chat.history', 'chat.resume', 'chat.send'],
  )
  for (const command of commands) {
    assert.equal(typeof command.entry, 'string')
    assert.equal(command.entry.length, 64, `${command.name} 入口应解析成 def 哈希`)
    assert.equal(command.argsSchema, null, `${command.name} 无 argsSchema（不设门）`)
    const body = anchor.world.defs[command.entry]?.body
    assert.deepEqual(body, EXPECTED_TERMS[command.name], `${command.name} 入口 term 不符`)
    // H21：eff 的目标能力类 = 自身 implements，且不在 pins 里（自能力路由，无自 pin）
    assert.equal(body[1], 'chat')
    assert.equal(Object.hasOwn(decl.decl.pins, 'chat'), false, 'chat 不应有自引用 pin')
  }
  console.log('命令：chat.send / chat.history / chat.resume 入口解析 + H21 自能力路由通过')

  // .worldignore：test/ 与 tools/ 不入世；execute/、terms/、schema/ 在
  assert.equal(resolveTreeEntry(anchor.world, decl.tree, 'test'), null, '.worldignore 应排除 test/')
  assert.equal(resolveTreeEntry(anchor.world, decl.tree, 'tools'), null, '.worldignore 应排除 tools/')
  assert.notEqual(resolveTreeEntry(anchor.world, decl.tree, 'execute'), null, 'execute/ 应入世')
  assert.notEqual(resolveTreeEntry(anchor.world, decl.tree, 'execute/main.ts'), null, 'execute/main.ts 应入世')
  assert.notEqual(resolveTreeEntry(anchor.world, decl.tree, 'terms/chat.send.json'), null, 'terms/ 应入世')
  assert.notEqual(resolveTreeEntry(anchor.world, decl.tree, 'terms/chat.resume.json'), null, 'terms/chat.resume.json 应入世')
  assert.notEqual(resolveTreeEntry(anchor.world, decl.tree, 'schema/wiring.json'), null, 'schema/wiring.json 应入世')
  console.log('.worldignore：test/ 与 tools/ 已排除，execute/ terms/（含 chat.resume）schema/ 在册')

  // 声明门禁负例：身份不一致即拒
  const gate = bootRaw(root, ['pack', join(REPO_ROOT, 'plugins', 'chat'), '--identity', 'wrong-identity'])
  assert.notEqual(gate.status, 0, '身份不一致应被声明门禁拒绝')
  console.log('声明门禁：identity_mismatch 负例被拒')

  const verified = boot(root, ['verify'])
  assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
  console.log('verify：ok')

  console.log(`E2E ok（root=${root}）`)
}

main()
