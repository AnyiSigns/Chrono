// 临时根世界：OS 临时目录里建一次性根 → 复制依赖缓存 / 原生产物 → 写 state/plugins.json → seed → start。
// 只在最外层边界放假（模型 HTTP 桩、Rust 重插件的同身份 toy、原生构建步骤）；其余全用真实插件与真实宿主。
// dispose 幂等：停宿主、清子进程、删临时根，测试抛错也能回收。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { connect } from '../../packages/client/index.ts'
import { runBoot, seed, start, status } from './boot.mjs'
import {
  NATIVE_CARGO_IDENTITIES,
  PLUGINS_DIR,
  REPO_ROOT,
  cargoIdentities,
  computeWorldIdentities,
  sourceDirFor,
  toyFor,
} from './closure.mjs'

const FIXTURE_BIN = join(REPO_ROOT, 'tests', 'fixtures', 'bin')
const NPM_CACHE_SRC = join(REPO_ROOT, 'state', 'deps', 'npm')
const TOKENIZER_NAME = process.platform === 'win32' ? 'tokenizer.dll' : 'libtokenizer.so'

/**
 * 原生 tokenizer 产物来源。计数的唯一实现在提供方 `token-estimate`（原生扩展）；
 * 候选按「插件包内 target/release → 宿主 ③ 共享缓存」顺序取第一个存在者。
 */
const TOKENIZER_SOURCES = [
  join(REPO_ROOT, 'plugins', 'token-estimate', 'target', 'release', TOKENIZER_NAME),
  join(REPO_ROOT, 'state', 'deps', 'cargo-target', 'release', TOKENIZER_NAME),
]

function tokenizerSource() {
  return TOKENIZER_SOURCES.find((candidate) => existsSync(candidate)) ?? TOKENIZER_SOURCES[0]
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Windows 环境变量键大小写不敏感：改写已有键而非新增重复键。 */
function prependPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === 'path') ?? 'Path'
  return { ...env, [key]: `${dir}${process.platform === 'win32' ? ';' : ':'}${env[key] ?? ''}` }
}

function lockPid(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, 'state', 'runtime', 'lock.json'), 'utf8'))
    return typeof parsed.pid === 'number' ? parsed.pid : null
  } catch {
    return null
  }
}

function killTree(pid) {
  if (pid === null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 进程已退出
    }
  }
}

/**
 * 建临时根并起宿主。
 * 返回句柄含：`root` / `closure` / `nativeTokenizerAvailable` / `loaded` / `connect()` / `dispose()`。
 * 宿主未就绪 / 原生 tokenizer 缺失时抛错（由调用方转成 skip 或失败），不静默假启动。
 */
export async function bootWorld(options = {}) {
  // 默认世界 = chat 的 pin 闭包 ∪ 其 needs 目标提供方（传递）。显式 `closure`（如能力槽夹具世界）按原样用。
  const closure = options.closure ?? computeWorldIdentities('chat')
  const cargo = cargoIdentities(closure)
  const unreplaceable = cargo.filter(
    (id) => !NATIVE_CARGO_IDENTITIES.has(id) && toyFor(id) === null,
  )
  if (unreplaceable.length > 0) {
    throw new Error(`e2e 缺少同名 toy 替身：${unreplaceable.join(', ')}`)
  }

  const root = mkdtempSync(join(tmpdir(), 'chrono-e2e-'))
  mkdirSync(join(root, 'state'), { recursive: true })
  const state = {
    root,
    closure,
    cargo,
    nativeTokenizerAvailable: false,
    loaded: [],
    hostPid: null,
    clients: [],
    disposed: false,
  }

  // 依赖缓存：model-protocol 的 npm ci 走宿主侧缓存目录，复制仓库已缓存内容以便离线恢复。
  if (existsSync(NPM_CACHE_SRC)) {
    cpSync(NPM_CACHE_SRC, join(root, 'state', 'deps', 'npm'), { recursive: true })
  }
  // 原生 tokenizer：预置到宿主依赖缓存，使物化后的 token-estimate（计数提供方）能加载
  // （构建步骤由 PATH 上的空操作 cargo 跳过）。
  const tokenizerSrc = tokenizerSource()
  if (existsSync(tokenizerSrc)) {
    const destDir = join(root, 'state', 'deps', 'cargo-target', 'release')
    mkdirSync(destDir, { recursive: true })
    cpSync(tokenizerSrc, join(destDir, TOKENIZER_NAME))
    state.nativeTokenizerAvailable = true
  }

  const manifest = closure.map((identity) => ({
    name: identity,
    path: options.overrides?.[identity] ?? sourceDirFor(identity, PLUGINS_DIR),
  }))
  for (const extra of options.extraPlugins ?? []) manifest.push({ name: extra.name, path: extra.path })
  const manifestPath = join(root, 'state', 'plugins.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const env = prependPath({ ...process.env }, FIXTURE_BIN)

  try {
    const seeded = seed(root, { env })
    if (seeded.status !== 0 || seeded.json?.ok !== true) {
      throw new Error(`seed 失败：${seeded.stderr || seeded.stdout || `exit ${seeded.status}`}`)
    }
    if (!state.nativeTokenizerAvailable) {
      // 早退：token-estimate 是 chat 链路 needs 的计数提供方，原生扩展缺失则计数不可用；
      // 由调用方 skip 并给出明确原因。
      throw new NativeTokenizerMissing(tokenizerSrc)
    }

    const started = start(root, { env })
    state.hostPid = typeof started.json?.pid === 'number' ? started.json.pid : lockPid(root)
    const ready = await waitForReady(root, options.readyTimeoutMs ?? 180_000)
    if (!ready) {
      const log = readFileSync(join(root, 'state', 'lifecycle.log'), 'utf8')
      const tail = log.split('\n').slice(-20).join('\n')
      throw new Error(`宿主未就绪；lifecycle 尾部：\n${tail}`)
    }
    state.loaded = await waitForLoaded(root, closure, options.loadedTimeoutMs ?? 120_000)
    return makeHandle(state)
  } catch (err) {
    await disposeWorld(state)
    throw err
  }
}

/** 原生 tokenizer 缺失：调用方据此 skip（需先有 `cargo build` 产物）。 */
export class NativeTokenizerMissing extends Error {
  constructor(source) {
    super(`context-window 原生 tokenizer 缺失：${source}；此环境无法在不构建的情况下跑真实回合`)
    this.name = 'NativeTokenizerMissing'
    this.source = source
  }
}

async function waitForReady(root, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const client = await connect({ root, timeoutMs: 1000 })
      try {
        await client.status()
        return true
      } finally {
        client.close()
      }
    } catch {
      if (Date.now() > deadline) return false
      await sleep(250)
    }
  }
}

/** 等装配完成：`status.loaded` 覆盖全部闭包身份（宿主 socket 就绪早于服务装载完成）。 */
async function waitForLoaded(root, identities, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let loaded = []
  for (;;) {
    const snapshot = status(root)
    loaded = Array.isArray(snapshot.json?.loaded) ? snapshot.json.loaded.map((item) => item.id) : []
    if (identities.every((id) => loaded.includes(id))) return loaded
    if (Date.now() > deadline) return loaded
    await sleep(500)
  }
}

function makeHandle(state) {
  return {
    root: state.root,
    closure: state.closure,
    cargo: state.cargo,
    nativeTokenizerAvailable: state.nativeTokenizerAvailable,
    loaded: state.loaded,
    /** 连接宿主；长超时以覆盖模型调用。 */
    async connect() {
      const client = await connect({ root: state.root, timeoutMs: 180_000 })
      state.clients.push(client)
      return client
    },
    dispose() {
      return disposeWorld(state)
    },
  }
}

async function disposeWorld(state) {
  if (state.disposed) return
  state.disposed = true
  for (const client of state.clients) {
    try {
      client.close()
    } catch {
      // 连接已断
    }
  }
  try {
    runBoot(state.root, ['stop'], { timeoutMs: 60_000 })
  } catch {
    // 宿主可能未起 / 已停
  }
  const pid = state.hostPid ?? lockPid(state.root)
  if (pid !== null) killTree(pid)
  rmSync(state.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
