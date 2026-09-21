// `sandbox` 宿主装配 E2E（重点验证宿主 Rust 物化链路）：
// pack sandbox → seed → start（宿主物化 + `cargo build --release` + 经 execute/launch.mjs 拉起 + 握手）
// → 轮询 status 确认 loaded → 校验缓存二进制与 .chrono-deps-ok 标记 → seed 档位映射数据世代
// → stop → verify + replay → 离线读投影确认 ids.sandbox.body = default-body.json。
// 首跑 cargo 需下载 crates 与编译，`boot start` 的 10s 就绪等待可能先超时——宿主是 detached 进程，
// 仍在后台装配，故超时后转轮询（失败路径也 stop，释放单写者锁）。
// 用法：node plugins/sandbox/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
const SANDBOX_DIR = join(REPO_ROOT, 'plugins', 'sandbox')
const SEED_SCRIPT = join(SANDBOX_DIR, 'tools', 'seed-default-body.mjs')
const DEFAULT_BODY = join(SANDBOX_DIR, 'tools', 'default-body.json')
const BIN_NAME = process.platform === 'win32' ? 'sandbox.exe' : 'sandbox'
const BUILD_DEADLINE_MS = 20 * 60 * 1000

function sleep(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function bootRaw(root, args) {
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
  return { status: result.status, stdout, stderr: result.stderr, parsed }
}

function boot(root, args) {
  const result = bootRaw(root, args)
  if (result.status !== 0) {
    throw new Error(`boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return result.parsed
}

function lifecycleTail(root) {
  const file = join(root, 'state', 'lifecycle.log')
  if (!existsSync(file)) return ''
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  return lines.slice(-20).join('\n')
}

function findMarker(dir) {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === '.chrono-deps-ok') {
      return join(entry.parentPath ?? entry.path, entry.name)
    }
  }
  return null
}

async function waitForLoaded(root) {
  const deadline = Date.now() + BUILD_DEADLINE_MS
  let lastError = ''
  while (Date.now() < deadline) {
    const result = bootRaw(root, ['status'])
    if (result.status === 0 && result.parsed && Array.isArray(result.parsed.loaded)) {
      if (result.parsed.loaded.some((entry) => entry.id === 'sandbox')) return result.parsed
    }
    lastError = result.stderr || result.stdout
    const log = lifecycleTail(root)
    if (/"impl":"sandbox"/.test(log) && /"event":"(start_failed|handshake.failed)"/.test(log)) {
      throw new Error(`sandbox 装配失败：\n${log}`)
    }
    await sleep(2000)
  }
  throw new Error(`sandbox 未在期限内装载（最后错误：${lastError}）\n${lifecycleTail(root)}`)
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** 极简协议客户端：按 4 字节大端长度前缀切帧。 */
function frameReader(child) {
  let buffer = Buffer.alloc(0)
  const queued = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      const message = JSON.parse(body.toString('utf8'))
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(message)
      else queued.push(message)
    }
  })
  return () =>
    new Promise((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error('等待协议帧超时')), 30000)
      const done = (message) => {
        clearTimeout(timer)
        resolveFrame(message)
      }
      if (queued.length > 0) done(queued.shift())
      else waiters.push(done)
    })
}

/** 协议直连 sandbox 二进制，真实调用一次 `fsop`（不依赖宿主派发，宿主侧无命令入口）。 */
async function protocolFsopSmoke(binary) {
  const workspace = join(tmpdir(), 'kilo', `chrono-sandbox-ws-${process.pid}-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'a.txt'), 'hello fsop\n')
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
  const nextFrame = frameReader(child)
  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'sandbox' }))
    const manifest = await nextFrame()
    assert.equal(manifest.kind, 'manifest', 'hello 应回 manifest')
    assert.equal(manifest.identity, 'sandbox')
    assert.deepEqual(manifest.methods.sandbox, ['exec', 'fsop', 'capabilities'])

    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'c1',
        kind: 'call',
        port: 'sandbox',
        method: 'fsop',
        args: {
          op: 'read',
          path: 'a.txt',
          args: {},
          tier: 'severe',
          workspace_root: workspace,
          caps: { fs: { read: 'full', write: 'full' }, net: 'none' },
        },
        env: { run: null, thread: null, now: 0 },
      }),
    )
    const read = await nextFrame()
    assert.equal(read.kind, 'result', `fsop 应回 result：${JSON.stringify(read)}`)
    assert.equal(read.value.ok, true, `fsop read 应 ok：${JSON.stringify(read.value)}`)
    assert.equal(read.value.result.text, 'hello fsop')

    // deny 档：真实经协议确认 fs 全拒。
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'c2',
        kind: 'call',
        port: 'sandbox',
        method: 'fsop',
        args: { op: 'read', path: 'a.txt', args: {}, tier: 'deny', workspace_root: workspace },
        env: { run: null, thread: null, now: 0 },
      }),
    )
    const denied = await nextFrame()
    assert.equal(denied.kind, 'result')
    assert.equal(denied.value.code, 'fs_denied', `deny 档应 fs_denied：${JSON.stringify(denied.value)}`)
    console.log('协议直连 fsop：read ok + deny 档 fs_denied')
  } finally {
    child.stdin.end()
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill()
        resolveExit()
      }, 10000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveExit()
      })
    })
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-sandbox-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', SANDBOX_DIR, '--identity', 'sandbox'])
    assert.equal(packed.ok, true, 'pack sandbox 报告 ok:false')
    console.log(`pack sandbox: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'sandbox', path: SANDBOX_DIR }]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    try {
      boot(root, ['start'])
      console.log('start：宿主就绪')
    } catch (err) {
      if (!/start_timeout/.test(err.message)) throw err
      console.log('start：10s 就绪等待超时，宿主仍在后台物化 / 编译，转轮询 status')
    }
    started = true

    const status = await waitForLoaded(root)
    console.log(`status：loaded = ${status.loaded.map((entry) => entry.id).join(', ')}`)

    const binPath = join(root, 'state', 'deps', 'cargo-target', 'release', BIN_NAME)
    assert.ok(existsSync(binPath), `缓存二进制缺失：${binPath}`)
    const marker = findMarker(join(root, 'state', 'runtime'))
    assert.ok(marker !== null, '未找到 .chrono-deps-ok 标记')
    console.log(`物化：二进制 + 依赖恢复标记就位（${binPath}）`)

    // 宿主侧 sandbox 无命令入口，故直接经服务协议调用真实 `fsop`。
    await protocolFsopSmoke(binPath)

    const seededBody = spawnSync(process.execPath, [SEED_SCRIPT, '--root', root], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
    })
    if (seededBody.status !== 0) {
      throw new Error(`seed 脚本失败（exit ${seededBody.status}）：${seededBody.stderr || seededBody.stdout}`)
    }
    const bodyResult = JSON.parse(seededBody.stdout.trim())
    assert.equal(bodyResult.ok, true, 'seed 脚本报告 ok:false')
    console.log(`seed 档位映射 body：${bodyResult.status}`)

    const afterSeed = boot(root, ['status'])
    assert.ok(
      afterSeed.loaded.some((entry) => entry.id === 'sandbox'),
      `seed 后 sandbox 未装载：${JSON.stringify(afterSeed.loaded)}`,
    )

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterSeed.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const expected = JSON.parse(readFileSync(DEFAULT_BODY, 'utf8'))
    assert.deepEqual(projection.ids.sandbox.body, expected)
    console.log('离线投影：ids.sandbox.body = 档位映射默认 body')

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
