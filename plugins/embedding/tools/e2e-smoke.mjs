// `embedding` 宿主装配 E2E（重点验证大资产直拷 + `include_bytes!` 全链路）：
// pack embedding → seed → start（宿主物化：assets_manifest 直拷大资产 → `cargo build --release`
// → 经 execute/launch.mjs 拉起 → 握手）→ 轮询 status 确认 loaded → 校验缓存二进制 / onnxruntime 库 /
// 物化目录里的大资产 → 协议直连 embed 断言 384 维与 L2 范数 → stop → verify。
// 首次 release 构建需下载 ort/onnxruntime 并编译 98 MB include_bytes!，可能 10–30 分钟；
// 宿主是 detached 进程，`boot start` 的 10s 就绪等待会先超时，故超时后转轮询（失败路径也 stop）。
// 用法：node plugins/embedding/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const EMBEDDING_DIR = join(REPO_ROOT, 'plugins', 'embedding')
const BIN_NAME = process.platform === 'win32' ? 'embedding.exe' : 'embedding'
const BUILD_DEADLINE_MS = 45 * 60 * 1000
const FRAME_TIMEOUT_MS = 180 * 1000

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

function findFile(dir, predicate) {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && predicate(entry.name)) {
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
      if (result.parsed.loaded.some((entry) => entry.id === 'embedding')) return result.parsed
    }
    lastError = result.stderr || result.stdout
    const log = lifecycleTail(root)
    if (/"impl":"embedding"/.test(log) && /"event":"(start_failed|handshake.failed)"/.test(log)) {
      throw new Error(`embedding 装配失败：\n${log}`)
    }
    await sleep(2000)
  }
  throw new Error(`embedding 未在期限内装载（最后错误：${lastError}）\n${lifecycleTail(root)}`)
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
      const timer = setTimeout(() => rejectFrame(new Error('等待协议帧超时')), FRAME_TIMEOUT_MS)
      const done = (message) => {
        clearTimeout(timer)
        resolveFrame(message)
      }
      if (queued.length > 0) done(queued.shift())
      else waiters.push(done)
    })
}

async function protocolSmoke(binary, pluginStateDir) {
  const child = spawn(binary, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: { ...process.env, CHRONO_PLUGIN_STATE: pluginStateDir },
  })
  const nextFrame = frameReader(child)
  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h1', kind: 'hello', impl: 'embedding' }))
    const manifest = await nextFrame()
    assert.equal(manifest.kind, 'manifest', 'hello 应回 manifest')
    assert.equal(manifest.identity, 'embedding')
    assert.deepEqual(manifest.methods.embedding, ['embed', 'chunk'])

    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'c1',
        kind: 'call',
        port: 'embedding',
        method: 'embed',
        args: { texts: ['Chrono 本地向量化冒烟测试。'], model: 'granite-97m' },
        env: { run: null, thread: null, now: 0 },
      }),
    )
    const result = await nextFrame()
    assert.equal(result.kind, 'result', `embed 应回 result：${JSON.stringify(result)}`)
    assert.equal(result.value.model, 'granite-97m')
    assert.equal(result.value.dim, 384)
    const vector = result.value.vectors[0]
    assert.equal(vector.length, 384, '向量应为 384 维')
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
    assert.ok(Math.abs(norm - 1) < 1e-3, `L2 范数应约为 1（实测 ${norm}）`)
    console.log(`协议直连 embed：dim=384，L2 范数=${norm.toFixed(6)}`)

    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'c2',
        kind: 'call',
        port: 'embedding',
        method: 'chunk',
        args: { text: '你好，world', window: 512, overlap: 64 },
        env: { run: null, thread: null, now: 0 },
      }),
    )
    const chunked = await nextFrame()
    assert.equal(chunked.kind, 'result', `chunk 应回 result：${JSON.stringify(chunked)}`)
    assert.equal(chunked.value.length, 1)
    assert.equal(chunked.value[0].start, 0)
    assert.equal(chunked.value[0].end, 8, 'start / end 应为 Unicode 码点偏移')
    console.log('协议直连 chunk：码点偏移 ok')
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
  const root = join(tmpdir(), 'kilo', `chrono-embedding-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', EMBEDDING_DIR, '--identity', 'embedding'])
    assert.equal(packed.ok, true, 'pack embedding 报告 ok:false')
    console.log(`pack embedding: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'embedding', path: EMBEDDING_DIR }]),
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
    console.log(`物化：缓存二进制就位（${binPath}）`)

    const runtimeDir = join(root, 'state', 'runtime')
    const modelCopy = findFile(runtimeDir, (name) => name === 'model_quint8_avx2.onnx')
    const tokenizerCopy = findFile(runtimeDir, (name) => name === 'tokenizer.json')
    assert.ok(modelCopy !== null, '大资产直拷：物化目录未见 model_quint8_avx2.onnx')
    assert.ok(tokenizerCopy !== null, '大资产直拷：物化目录未见 tokenizer.json')
    console.log(`大资产直拷：大资产已直拷进物化目录（${dirname(modelCopy)}）`)

    const dylib = findFile(join(root, 'state', 'deps', 'cargo-target', 'release'), (name) =>
      /^onnxruntime.*\.dll$/i.test(name),
    )
    console.log(dylib === null ? '物化：未发现独立 onnxruntime DLL（可能静态链接）' : `物化：onnxruntime 库就位（${dylib}）`)

    await protocolSmoke(binPath, join(root, 'state', 'plugins', 'embedding'))

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    console.log('verify：ok')

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
