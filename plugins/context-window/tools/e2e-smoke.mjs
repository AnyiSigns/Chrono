// `context-window` 宿主装配 E2E（重点验证 H15 原生子组件物化链路）：
// pack → seed → start（宿主物化 + `cargo build --release` 构建 native/tokenizer + 服务启动握手）
// → 轮询 status 确认 loaded（native 加载失败服务会先死 → 隔离，这本身是红线行为）
// → 校验宿主依赖缓存里的 cdylib 与 `.chrono-deps-ok` 标记 → 协议直连服务调 `context.build`（合成 bag）
//   收 `context.assembled` 事件（CHRONO_PLUGIN_STATE 指到宿主 ③ 目录，走宿主构建的 cdylib）
// → stop → verify + replay → 离线读投影确认身份已入世。
// 首跑 cargo 需编译（依赖已缓存时离线可完成），10s 就绪等待可能先超时——宿主是 detached 进程，
// 仍在后台装配，故超时后转轮询（失败路径也 stop，释放单写者锁）。
// 用法：node plugins/context-window/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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
const PKG_DIR = join(REPO_ROOT, 'plugins', 'context-window')
const ENTRY = join(PKG_DIR, 'execute', 'main.ts')
const LIB_NAME = process.platform === 'win32' ? 'tokenizer.dll' : 'libtokenizer.so'
const BUILD_DEADLINE_MS = 20 * 60 * 1000
const FIXED_ENV = { run: 'e2e-run', thread: 'e2e-thread', now: 1_700_000_000_000 }

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
  return readFileSync(file, 'utf8').trim().split('\n').slice(-20).join('\n')
}

function findFileNamed(dir, name) {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name === name) {
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
      if (result.parsed.loaded.some((entry) => entry.id === 'context-window')) return result.parsed
    }
    lastError = result.stderr || result.stdout
    const log = lifecycleTail(root)
    if (/"impl":"context-window"/.test(log) && /"event":"(start_failed|handshake.failed)"/.test(log)) {
      throw new Error(`context-window 装配失败：\n${log}`)
    }
    await sleep(2000)
  }
  throw new Error(`context-window 未在期限内装载（最后错误：${lastError}）\n${lifecycleTail(root)}`)
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const frame = Buffer.allocUnsafe(4 + body.length)
  frame.writeUInt32BE(body.length, 0)
  body.copy(frame, 4)
  return frame
}

function createDecoder() {
  let buffered = Buffer.alloc(0)
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
      const messages = []
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0)
        if (buffered.length < 4 + length) break
        const body = buffered.subarray(4, 4 + length).toString('utf8')
        buffered = buffered.subarray(4 + length)
        messages.push(JSON.parse(body))
      }
      return messages
    },
  }
}

/** 协议直连服务：hello → context.build，收 event 帧，返回 value 与事件。 */
function callBuild(stateDir) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd: PKG_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CHRONO_PLUGIN_STATE: stateDir },
    })
    const decoder = createDecoder()
    const pending = new Map()
    const events = []
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error('context-window 服务调用超时'))
    }, 20000)
    child.stdout.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'event') {
          events.push(message)
          continue
        }
        const handler = pending.get(message.id)
        if (handler !== undefined) {
          pending.delete(message.id)
          handler(message)
        }
      }
    })
    child.stderr.on('data', () => {})
    let seq = 0
    function request(kind, fields, expect) {
      seq += 1
      const id = `e2e-${seq}`
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, (message) => {
          if (message.kind !== expect) {
            rejectRequest(new Error(`expected ${expect} got ${message.kind}`))
            return
          }
          resolveRequest(message)
        })
        child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
      })
    }
    ;(async () => {
      await request('hello', { impl: 'context-window', gen: 'e2e' }, 'manifest')
      const bag = {
        input: 'hello',
        system_prompt: 'You are a helpful agent.',
        tools: [{ name: 't1', schema: { type: 'object' } }],
        memories: { l2: { summary: 'e2e' } },
        session: { head: null, refs: {} },
        config: { model: 'e2e-model', context_window: 1000, max_output: 100 },
      }
      const result = await request(
        'call',
        { port: 'context', method: 'build', args: bag, env: FIXED_ENV },
        'result',
      )
      clearTimeout(timer)
      child.stdin.end()
      resolveCall({ value: result.value, events })
    })().catch((err) => {
      clearTimeout(timer)
      child.kill()
      rejectCall(err)
    })
  })
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-context-window-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packed = boot(root, ['pack', PKG_DIR, '--identity', 'context-window'])
    assert.equal(packed.ok, true, 'pack context-window 报告 ok:false')
    console.log(`pack context-window: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'context-window', path: PKG_DIR }]),
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

    const binPath = join(root, 'state', 'deps', 'cargo-target', 'release', LIB_NAME)
    assert.ok(existsSync(binPath), `宿主依赖缓存里的 cdylib 缺失：${binPath}`)
    const marker = findFileNamed(join(root, 'state', 'runtime'), '.chrono-deps-ok')
    assert.ok(marker !== null, '未找到 .chrono-deps-ok 标记')
    const nativeSource = findFileNamed(join(root, 'state', 'runtime'), 'lib.rs')
    assert.ok(nativeSource !== null, '物化目录缺 native/tokenizer/src/lib.rs（源码未入世）')
    console.log(`H15：cdylib + 依赖恢复标记 + native 源码就位（${binPath}）`)

    const stateDir = join(root, 'state', 'plugins', 'context-window')
    const { value, events } = await callBuild(stateDir)
    assert.equal(value.ok, true, `build 未成功：${JSON.stringify(value)}`)
    assert.ok(Array.isArray(value.messages) && value.messages.length > 0)
    assert.equal(value.manifest.run, 'e2e-run')
    assert.equal(value.manifest.thread, 'e2e-thread')
    assert.equal(events.length, 1)
    assert.equal(events[0].topic, 'context.assembled')
    assert.equal(events[0].payload.run, 'e2e-run')
    assert.equal(events[0].payload.model, 'e2e-model')
    console.log(`协议直连 context.build：ok（used=${value.manifest.used}，事件 topic=${events[0].topic}）`)

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与停机前 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const identity = projection.ids['context-window']
    assert.ok(identity !== undefined, '投影缺 context-window 身份')
    assert.ok(identity.active !== null, 'context-window 身份未激活')
    console.log('离线投影：context-window 身份已入世且激活')

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
