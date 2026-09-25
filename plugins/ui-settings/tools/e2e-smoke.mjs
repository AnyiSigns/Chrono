// `ui-settings` 宿主装配 E2E（黑盒，经 boot CLI）。客户端半边改由插件自交付（只读命令
// `ui-settings.client.read`）后本插件已无 HTTP 面：本脚本不起任何端口、不请求 `/entry.js`、
// 不经 `/p/` 反代，全部断言走离线面。
//
// 默认（离线，无需 npm ci / 网络）：
//   ① 入世树核对（`.worldignore`：契约文件入世，test/ / tools/ / execute/web/dist/ 排除）
//   ② plugin.json 形态断言（零 schema、无 exclusive、client.read 只读、build = npm ci + node execute/build.mjs）
//   ③ seed 真实 pins 闭包（记忆族 / 模型协议 / 密钥 / 会话等，pins 在入世批内解析）
//   ④ pack（已入世 → unchanged）
//   ⑤ client.read 路径穿越防护 + 正常读回（直调服务方法，与既有单测同口径）
//   ⑥ entry.tsx 导出 contract / register、不再导出 mount（esbuild 擦类型后真实 import）
//   ⑦ verify
//
// 可选（需 npm ci / 网络；仅 `CHRONO_E2E_BOOT=1` 时执行）：宿主 `start` 装配段
//   （seed 记忆族桩 → start → 轮询 loaded → commands 含 ui-settings.client.read →
//   client.read 命令真实往返 → stop → verify + replay）。默认跳过，故本脚本可离线跑通。
//
// 用法：node plugins/ui-settings/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'
import { createHandlers } from '../execute/methods.ts'
import { isSafeClientPath, readClientFile, resolveClientPath } from '../execute/client-read.ts'
import { extractValue } from '../execute/bridge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const SETTINGS_DIR = join(REPO_ROOT, 'plugins', 'ui-settings')
const WEB_DIR = join(SETTINGS_DIR, 'execute', 'web')

/** ① pins 段真实闭包（拓扑序）：记忆族 / 模型协议 / 密钥 / 会话等，pins 在 seed 批内解析。 */
const PINS_CLOSURE = [
  'secrets',
  'config',
  'embedding',
  'short-memory',
  'model-protocol',
  'compress',
  'memory-store',
  'input',
  'session',
  'memory-retrieval',
  'skill',
  'memory-consolidate',
  'ui-settings',
]

/** 可选 start 段的依赖（pins 需先入世）；记忆族用桩避免 Rust 物化。 */
const BOOT_PACKAGES = [
  'config',
  'input',
  'skill',
  'agents',
  'evolution',
  'vendor-deepseek',
  'vendor-custom',
  'secrets',
  'model-protocol',
]

/** 记忆族桩：只声明能力、无 start（仅让 `ui-settings` 的 pins 可解析）。 */
const STUB_PACKAGES = [
  ['memory-retrieval', ['retrieval'], { retrieval: ['search'] }],
  ['memory-consolidate', ['memory-maintenance'], { 'memory-maintenance': ['view', 'edit'] }],
]

function boot(root, args, env) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: env ?? process.env,
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

async function waitFor(predicate, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
}

/** 从打包子操作里收集树内文件路径（目录 put 的 entries；文件条目 hash 是真实哈希）。 */
function collectPackedPaths(ops, rootIndex) {
  const paths = []
  const walk = (index, prefix) => {
    const body = ops[index]?.args?.body
    const entries = body?.entries
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const name = entry?.name
      if (typeof name !== 'string') continue
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      if (entry.mode === 'dir' && entry.hash !== null && typeof entry.hash === 'object' && Number.isInteger(entry.hash.$n)) {
        walk(entry.hash.$n, path)
      } else if (entry.mode === 'file') {
        paths.push(path)
      }
    }
  }
  walk(rootIndex, '')
  return paths
}

/** ① 入世树核对：契约文件入世，test/ / tools/ / execute/web/dist/ 排除。 */
function assertWorldTree() {
  const worldignore = readWorldignore(SETTINGS_DIR)
  assert.equal(worldignore.ok, true, '.worldignore 解析失败')
  for (const pattern of [['test'], ['tools'], ['execute', 'web', 'dist']]) {
    assert.ok(
      worldignore.patterns.some((item) => item.join('/') === pattern.join('/')),
      `.worldignore 缺 ${pattern.join('/')}`,
    )
  }
  const source = packSourceDir(SETTINGS_DIR, worldignore.patterns)
  const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
  for (const required of [
    'plugin.json',
    'package.json',
    'package-lock.json',
    'README.md',
    'tsconfig.json',
    'execute/main.ts',
    'execute/methods.ts',
    'execute/client-read.ts',
    'execute/build.mjs',
    'execute/web/entry.tsx',
    'execute/web/components/App.tsx',
    'execute/web/view-context.ts',
    'terms/client.read.json',
    'terms/model.vendors.json',
    'terms/memory.view.json',
    'terms/secret.json',
  ]) {
    assert.ok(packedPaths.includes(required), `入世树缺 ${required}`)
  }
  assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
  assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
  assert.ok(!packedPaths.some((path) => path.startsWith('execute/web/dist/')), '入世树含构建产物 dist/')
  assert.ok(!packedPaths.some((path) => path.startsWith('node_modules/')), '入世树含 node_modules/')
  console.log(`入世树：ok（${packedPaths.length} 个文件，排除 test/ / tools/ / execute/web/dist/）`)
}

/** ② plugin.json 形态断言（契约字段，离线读）。 */
function assertDeclaration() {
  const decl = JSON.parse(readFileSync(join(SETTINGS_DIR, 'plugin.json'), 'utf8'))
  assert.equal(decl.identity, 'ui-settings')
  assert.equal(decl.start, 'node execute/main.ts')
  assert.equal(Object.hasOwn(decl, 'schema'), false, 'UI 插件应零 schema（省略字段）')
  assert.equal(Object.hasOwn(decl, 'exclusive'), false, '客户端半边自交付后不再独占端口')
  assert.deepEqual(decl.implements, ['ui-settings'])
  assert.deepEqual(decl.methods['ui-settings'], ['ping', 'vendors', 'profile', 'discover', 'health', 'scopes', 'view', 'search', 'edit', 'client.read', 'secret'])
  assert.deepEqual(decl.pins, {
    model: 'model-protocol',
    secrets: 'secrets',
    retrieval: 'memory-retrieval',
    'memory-maintenance': 'memory-consolidate',
    session: 'session',
    'short-memory': 'short-memory',
    input: 'input',
    skill: 'skill',
    config: 'config',
    host: 'host',
  })
  assert.deepEqual(decl.members, [
    { kind: 'execute', path: 'execute/' },
    { kind: 'term', path: 'terms/' },
  ])
  const clientRead = decl.commands.find((command) => command.name === 'ui-settings.client.read')
  assert.ok(clientRead !== undefined, 'commands 缺 ui-settings.client.read')
  assert.equal(clientRead.readonly, true, 'ui-settings.client.read 只读')
  assert.equal(clientRead.entry, 'terms/client.read.json')
  for (const command of decl.commands) {
    assert.equal(Object.hasOwn(command, 'argsSchema'), false, `${command.name} 无参不应声明 argsSchema`)
    assert.ok(readFileSync(join(SETTINGS_DIR, command.entry), 'utf8').length > 0, `${command.entry} 应存在`)
  }
  assert.ok(Array.isArray(decl.build) && decl.build.length === 2, 'build 应为两步')
  for (const step of decl.build) {
    assert.ok(Array.isArray(step.args), 'build 步骤应带 args')
    for (const arg of step.args) assert.equal(arg.includes('='), false, `args 令牌不得含 '='：${arg}`)
  }
  assert.deepEqual(decl.build[0], { cmd: 'npm', args: ['ci'] })
  assert.deepEqual(decl.build[1], { cmd: 'node', args: ['execute/build.mjs'] })
  assert.ok(existsSync(join(SETTINGS_DIR, 'execute', 'build.mjs')), '构建脚本 execute/build.mjs 应存在')
  console.log('plugin.json：ok（零 schema、无 exclusive、client.read 只读、build = npm ci + node execute/build.mjs）')
}

/** ③ seed 真实 pins 闭包（离线）：seed 成功即 pins 在入世批内解析。 */
function seedPinsClosure() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-settings-seed-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  writeFileSync(
    join(root, 'state', 'plugins.json'),
    JSON.stringify(PINS_CLOSURE.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) })), null, 2),
  )
  const seeded = boot(root, ['seed'])
  assert.equal(seeded.ok, true, `seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
  const settingsItem = seeded.items.find((item) => item.name === 'ui-settings')
  assert.ok(settingsItem !== undefined, 'seed 报告缺 ui-settings')
  assert.equal(settingsItem.identity, 'ui-settings')
  assert.ok(
    settingsItem.status === 'seeded' || settingsItem.status === 'unchanged',
    `ui-settings seed 状态异常：${settingsItem.status}`,
  )
  console.log(`seed：${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)
  return root
}

/** ④ pack（已入世 → unchanged；pins 已解析）。 */
function assertPack(root) {
  const packed = boot(root, ['pack', SETTINGS_DIR, '--identity', 'ui-settings'])
  assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
  assert.equal(packed.identity, 'ui-settings')
  assert.ok(packed.status === 'packed' || packed.status === 'unchanged', `pack 状态异常：${packed.status}`)
  console.log(`pack：ok（identity=${packed.identity}，status=${packed.status}）`)
}

/** 确保客户端半边产物存在（本地 esbuild，离线）；缺失时按 build 步骤生成。 */
function ensureBuilt() {
  const outfile = join(WEB_DIR, 'dist', 'entry.js')
  if (existsSync(outfile)) return outfile
  const result = spawnSync(process.execPath, ['execute/build.mjs'], { cwd: SETTINGS_DIR, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`构建客户端半边失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  assert.ok(existsSync(outfile), '构建后仍缺 execute/web/dist/entry.js')
  return outfile
}

/** ⑤ client.read：路径穿越防护 + 正常读回（直调服务方法）。 */
function assertClientRead() {
  // 语法层防护（纯函数）。
  assert.equal(isSafeClientPath('dist/entry.js'), true)
  assert.equal(isSafeClientPath('a/b/c.js'), true)
  for (const bad of ['/etc/passwd.js', 'C:/x.js', 'C:\\x.js', 'a\\b.js', '../plugin.json', 'dist/../../x.js', 'dist//x.js', './x.js', 'dist/entry.ts', '', null, 42, ['dist/entry.js']]) {
    assert.equal(isSafeClientPath(bad), false, `应拒绝非法路径：${String(bad)}`)
  }
  // 解析层防护（越界返回 null）。
  assert.equal(resolveClientPath(WEB_DIR, 'dist/entry.js'), join(WEB_DIR, 'dist', 'entry.js'))
  assert.equal(resolveClientPath(WEB_DIR, '../plugin.json'), null)
  assert.equal(readClientFile(WEB_DIR, '../plugin.json'), null)
  assert.equal(readClientFile(WEB_DIR, '/etc/passwd.js'), null)
  assert.equal(readClientFile(WEB_DIR, 'dist/missing.js'), null)

  // 正常读回：产物字节（缺失时按 build 步骤本地生成，离线）。
  ensureBuilt()
  const text = readClientFile(WEB_DIR, 'dist/entry.js')
  assert.equal(typeof text, 'string', 'client.read 应读回产物文本')
  assert.ok(text.includes('export'), 'entry.js 应是 ESM 产物')

  // 方法层：{path} → {path,text}；非法路径结构化失败（fail-closed）。
  const handlers = createHandlers({ identity: 'ui-settings', model: { call: async () => ({ ok: false, code: 'x', message: '' }) } })
  const env = { run: null, thread: null, now: 0 }
  const read = handlers['client.read']({ path: 'dist/entry.js' }, env)
  assert.equal(read.path, 'dist/entry.js')
  assert.ok(read.text.includes('export'))
  const traversal = handlers['client.read']({ path: '../plugin.json' }, env)
  assert.equal(traversal.ok, false)
  assert.equal(traversal.error.code, 'client_read_bad_path')
  const missing = handlers['client.read']({ path: 'dist/missing.js' }, env)
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'client_read_missing')
  console.log(`client.read：ok（产物 ${text.length} 字节读回；绝对 / 盘符 / 反斜杠 / .. / 空段 / 非 js 均拒绝）`)
}

/** ⑥ entry.tsx 导出 contract / register、无 mount（esbuild 擦类型 + react 桩后真实 import）。 */
async function assertEntryExports() {
  const root = join(tmpdir(), 'kilo', `chrono-ui-settings-entry-${Date.now()}`)
  mkdirSync(root, { recursive: true })
  try {
    const reactStub = join(root, 'react-stub.js')
    const jsxStub = join(root, 'jsx-runtime-stub.js')
    writeFileSync(
      reactStub,
      'export const useState = (v) => [typeof v === "function" ? v() : v, () => {}]\n' +
        'export const useEffect = () => {}\n' +
        'export const useRef = (v) => ({ current: v })\n' +
        'export const useCallback = (f) => f\n' +
        'export const useMemo = (f) => (typeof f === "function" ? f() : f)\n' +
        'export const useContext = () => ({})\n' +
        'export const createContext = (value) => ({ Provider: (props) => props.children ?? null, Consumer: null, _currentValue: value })\n' +
        'export const cloneElement = (el) => el\n' +
        'export const useId = () => "id"\n' +
        'export const createElement = () => null\n' +
        'export const Fragment = Symbol("Fragment")\n',
    )
    writeFileSync(jsxStub, 'export const jsx = () => null\nexport const jsxs = () => null\nexport const Fragment = Symbol("Fragment")\n')
    const outfile = join(root, 'entry.mjs')
    await build({
      entryPoints: [join(WEB_DIR, 'entry.tsx')],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      jsx: 'automatic',
      alias: { react: reactStub, 'react/jsx-runtime': jsxStub },
      logLevel: 'silent',
    })
    const module = await import(pathToFileURL(outfile).href)
    assert.equal(module.contract, '2')
    assert.equal(typeof module.register, 'function')
    assert.equal(module.mount, undefined, '客户端半边不再导出 mount')
    console.log('entry.tsx：ok（contract = "2" + register(ctx)；无 mount）')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeStubPackage(root, identity, implementsList, methods) {
  const dir = join(root, 'stubs', identity)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify(
      { identity, implements: implementsList, methods, pins: {}, start: '', protocol: '1', restart: {}, health: {}, state: 'recomputable', members: [], commands: [] },
      null,
      2,
    ),
  )
  return dir
}

/**
 * 可选宿主装配段（需 npm ci / 网络）：`CHRONO_E2E_BOOT=1` 时执行。
 * 客户端半边自交付后只验证命令面与只读交付，不再有 HTTP / SSE / 端口。
 */
async function runBootPhase() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-settings-boot-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const entries = BOOT_PACKAGES.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) }))
    for (const [identity, implementsList, methods] of STUB_PACKAGES) {
      entries.push({ name: identity, path: writeStubPackage(root, identity, implementsList, methods) })
    }
    entries.push({ name: 'ui-settings', path: SETTINGS_DIR })
    writeFileSync(join(root, 'state', 'plugins.json'), JSON.stringify(entries, null, 2))

    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, `boot seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
    boot(root, ['start'])
    started = true
    await waitFor(() => boot(root, ['status']).loaded.some((item) => item.id === 'ui-settings'), 'ui-settings loaded', 180000)
    const commands = boot(root, ['commands'])
    assert.ok(JSON.stringify(commands).includes('ui-settings.client.read'), `命令面应含 ui-settings.client.read：${JSON.stringify(commands)}`)
    const readValue = extractValue(boot(root, ['ui-settings.client.read', JSON.stringify({ path: 'dist/entry.js' })]))
    assert.equal(readValue.path, 'dist/entry.js', JSON.stringify(readValue))
    assert.ok(readValue.text.includes('export'), 'client.read 应回 ESM 产物')
    const traversal = extractValue(boot(root, ['ui-settings.client.read', JSON.stringify({ path: '../plugin.json' })]))
    assert.equal(traversal.ok, false, '穿越路径应被拒')
    const beforeStop = boot(root, ['status'])
    boot(root, ['stop'])
    started = false
    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, beforeStop.world_head, 'replay 链头与 status 不一致')
    console.log('宿主装配段（start / commands / client.read / stop / verify + replay）：ok')
  } finally {
    if (started) {
      try {
        boot(root, ['stop'])
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
    rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  // 离线面（默认全部执行）。
  assertWorldTree()
  assertDeclaration()
  const seedRoot = seedPinsClosure()
  try {
    assertPack(seedRoot)
    assertClientRead()
    await assertEntryExports()
    const verified = boot(seedRoot, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    console.log('verify：ok')
  } finally {
    rmSync(seedRoot, { recursive: true, force: true })
  }

  // 可选面：需 npm ci / 网络，显式开启才跑（默认离线跳过）。
  if (process.env.CHRONO_E2E_BOOT === '1') {
    await runBootPhase()
  } else {
    console.log('宿主装配段：跳过（需 npm ci / 网络；设 CHRONO_E2E_BOOT=1 启用）')
  }

  console.log('E2E ok（离线面）')
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
