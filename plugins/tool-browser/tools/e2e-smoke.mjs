// `tool-browser` 宿主装配 E2E：
// pack sandbox + tool-browser → seed → start（宿主物化 + sandbox 编译 + 握手）→ 轮询 status 确认两身份 loaded
// → 直连服务 stdio（注入假引擎模块，把 port.call 桥接到 E2E 内的假 sandbox / host 后端）
// → 驱动九个 action 与会话生命周期（含 TTL 回收、net_denied、browser_unsupported）→ stop → verify/replay
// → 离线读投影确认身份在册。
// 首跑 sandbox 需 `cargo build --release`，`boot start` 的就绪等待可能先超时——宿主是 detached 进程，
// 仍在后台装配，故超时后转轮询（失败路径也 stop，释放单写者锁）。
// 用法：node plugins/tool-browser/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
const SANDBOX_DIR = join(REPO_ROOT, 'plugins', 'sandbox')
const TOOLBROWSER_DIR = join(REPO_ROOT, 'plugins', 'tool-browser')
const FAKE_ENGINE = join(TOOLBROWSER_DIR, 'test', 'fake-engine.mjs')
const MISSING_ENGINE = join(TOOLBROWSER_DIR, 'test', 'does-not-exist.mjs')
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
  return readFileSync(file, 'utf8').trim().split('\n').slice(-20).join('\n')
}

async function waitForLoaded(root, identities) {
  const deadline = Date.now() + BUILD_DEADLINE_MS
  let lastError = ''
  while (Date.now() < deadline) {
    const result = bootRaw(root, ['status'])
    if (result.status === 0 && result.parsed && Array.isArray(result.parsed.loaded)) {
      const loaded = result.parsed.loaded
      if (identities.every((id) => loaded.some((entry) => entry.id === id))) return result.parsed
    }
    lastError = result.stderr || result.stdout
    const log = lifecycleTail(root)
    if (/"event":"(start_failed|handshake\.failed|service\.exit)"/.test(log)) {
      throw new Error(`插件装配失败：\n${log}`)
    }
    await sleep(2000)
  }
  throw new Error(`身份未在期限内装载（${identities.join(', ')}；最后错误：${lastError}）\n${lifecycleTail(root)}`)
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
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

function waitExit(child) {
  return new Promise((resolveExit) => {
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

/** 直连服务 stdio：注入假引擎，port.call 桥接到假 sandbox / host 后端。 */
function startDriver(envOverrides = {}) {
  const child = spawn(process.execPath, ['execute/main.ts'], {
    cwd: TOOLBROWSER_DIR,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
    env: { ...process.env, CHRONO_BROWSER_ENGINE_MODULE: FAKE_ENGINE, ...envOverrides },
  })
  const decoder = createDecoder()
  const pending = new Map()
  const portCalls = []
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'port.call') {
        portCalls.push(message)
        if (message.port === 'sandbox' && message.method === 'capabilities') {
          child.stdin.write(
            encodeFrame({
              v: '1',
              id: message.id,
              kind: 'port.result',
              ok: true,
              value: { platform: process.platform, implementations: [], default_impl: 'native', enforcement: { net: 'declaration' } },
            }),
          )
        } else if (message.port === 'host' && message.method === 'asset.put') {
          const bytes = Buffer.from(message.args.bytes, 'base64')
          child.stdin.write(
            encodeFrame({
              v: '1',
              id: message.id,
              kind: 'port.result',
              ok: true,
              value: { kind: 'asset', sha256: createHash('sha256').update(bytes).digest('hex'), mime: message.args.mime, size: bytes.length },
            }),
          )
        } else {
          child.stdin.write(
            encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'unresolved_cap', message: 'no bridge' }),
          )
        }
        continue
      }
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `e2e-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`等待 ${kind} 的 ${expected.join('/')} 超时`))
      }, 15000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`期望 ${expected.join('/')} 实得 ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  const bag = (args, extra = {}) => ({ tool: 'webbrowser', args, tier: 'auto', caps: { net: 'all' }, ...extra })
  const env = (now = 0, run = 'e2e-run') => ({ run, thread: null, now })

  return {
    child,
    portCalls,
    hello: () => request('hello', { impl: 'tool-browser', gen: 'e2e' }, 'manifest'),
    describe: () => request('call', { port: 'tool-browser', method: 'describe', args: {}, env: env() }, ['result', 'error']),
    invoke: (args, extra = {}, callEnv = env()) =>
      request('call', { port: 'tool-browser', method: 'invoke', args: bag(args, extra), env: callEnv }, ['result', 'error']),
    close: () => child.stdin.end(),
  }
}

/** 会话全流程：九个 action + 状态保持 + close / TTL / net / 资产。 */
async function sessionSmoke() {
  const driver = startDriver()
  try {
    const manifest = await driver.hello()
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.identity, 'tool-browser')
    assert.deepEqual(manifest.methods['tool-browser'], ['describe', 'invoke'])

    const described = await driver.describe()
    const tool = described.value.tools[0]
    assert.equal(tool.name, 'webbrowser')
    assert.equal(tool.caps.net, 'all')
    assert.equal(tool.caps.fs.read, 'none')
    assert.equal(tool.idempotent, false)
    assert.deepEqual(tool.render.detail, { kind: 'json' })

    const opened = await driver.invoke({ action: 'open' })
    assert.equal(opened.value.ok, true, JSON.stringify(opened.value))
    const session = opened.value.result.session
    assert.equal(session, 'e2e-run~1', '会话 id 应由 run + 序号确定性派生')

    const navigated = await driver.invoke({ action: 'navigate', session, url: 'https://example.com' })
    assert.deepEqual(navigated.value.result, { status: 200, url: 'https://example.com', title: 'title:https://example.com' })
    assert.deepEqual((await driver.invoke({ action: 'click', session, selector: '#a' })).value.result, { ok: true })
    assert.deepEqual((await driver.invoke({ action: 'type', session, selector: 'input', text: 'hi', submit: true })).value.result, { ok: true })
    assert.deepEqual((await driver.invoke({ action: 'press', session, key: 'Enter' })).value.result, { ok: true })
    assert.deepEqual((await driver.invoke({ action: 'wait_for', session, ms: 10 })).value.result, { ok: true })
    assert.deepEqual((await driver.invoke({ action: 'extract', session })).value.result, { text: 'hello body' })
    assert.deepEqual((await driver.invoke({ action: 'extract', session, selector: '#a', attr: 'href' })).value.result, { value: '/a' })

    const shot = await driver.invoke({ action: 'screenshot', session, full_page: true })
    assert.equal(shot.value.result.asset.kind, 'asset')
    assert.equal(shot.value.result.asset.mime, 'image/png')
    assert.match(shot.value.result.asset.sha256, /^[0-9a-f]{64}$/)
    assert.ok(driver.portCalls.some((call) => call.port === 'host' && call.method === 'asset.put'), '截图应经 host.asset.put')

    assert.deepEqual((await driver.invoke({ action: 'close', session })).value.result, { closed: true })
    const afterClose = await driver.invoke({ action: 'navigate', session, url: 'https://x.test' })
    assert.equal(afterClose.value.error.code, 'session_not_found')

    // net 声明级钳制：all 需求下 severe(limited) / review(none) 均越档
    for (const tier of ['severe', 'review']) {
      const denied = await driver.invoke({ action: 'open' }, { tier })
      assert.equal(denied.value.error.code, 'net_denied', `tier=${tier}`)
    }

    // TTL 回收：同一 run 新开会话，下一次调用 now 远超空闲上限
    const ttlOpened = await driver.invoke({ action: 'open' }, {}, { run: 'ttl-run', thread: null, now: 0 })
    const ttlSession = ttlOpened.value.result.session
    const ttlAfter = await driver.invoke({ action: 'extract', session: ttlSession }, {}, { run: 'ttl-run', thread: null, now: 999999 })
    assert.equal(ttlAfter.value.error.code, 'session_not_found')

    console.log('直连协议：describe 契约 + 九个 action + 会话保持 / close / TTL / net_denied / 截图资产')
  } finally {
    driver.close()
    await waitExit(driver.child)
  }
}

/** 引擎不可用：注入不存在的引擎模块，open 明确回 browser_unsupported。 */
async function unsupportedSmoke() {
  const driver = startDriver({ CHRONO_BROWSER_ENGINE_MODULE: MISSING_ENGINE })
  try {
    await driver.hello()
    const opened = await driver.invoke({ action: 'open' })
    assert.equal(opened.value.ok, false)
    assert.equal(opened.value.error.code, 'browser_unsupported')
    console.log('引擎不可用：browser_unsupported（明确失败）')
  } finally {
    driver.close()
    await waitExit(driver.child)
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-tool-browser-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    const packedSandbox = boot(root, ['pack', SANDBOX_DIR, '--identity', 'sandbox'])
    assert.equal(packedSandbox.ok, true, 'pack sandbox 报告 ok:false')
    const packedBrowser = boot(root, ['pack', TOOLBROWSER_DIR, '--identity', 'tool-browser'])
    assert.equal(packedBrowser.ok, true, 'pack tool-browser 报告 ok:false')
    console.log(`pack：sandbox=${packedSandbox.status} tool-browser=${packedBrowser.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'sandbox', path: SANDBOX_DIR },
        { name: 'tool-browser', path: TOOLBROWSER_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed：${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    try {
      boot(root, ['start'])
      console.log('start：宿主就绪')
    } catch (err) {
      if (!/start_timeout/.test(err.message)) throw err
      console.log('start：就绪等待超时，宿主仍在后台物化 / 编译，转轮询 status')
    }
    started = true

    const status = await waitForLoaded(root, ['sandbox', 'tool-browser'])
    console.log(`status：loaded = ${status.loaded.map((entry) => entry.id).join(', ')}`)

    await sessionSmoke()
    await unsupportedSmoke()

    const afterSmoke = boot(root, ['status'])
    assert.ok(
      afterSmoke.loaded.some((entry) => entry.id === 'tool-browser'),
      `smoke 后 tool-browser 未装载：${JSON.stringify(afterSmoke.loaded)}`,
    )

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterSmoke.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    assert.ok(projection.ids.sandbox !== undefined, '投影缺 sandbox 身份')
    assert.ok(projection.ids['tool-browser'] !== undefined, '投影缺 tool-browser 身份')
    assert.equal(projection.ids['tool-browser'].active === null, false, 'tool-browser 身份应 active')
    console.log('离线投影：sandbox / tool-browser 身份在册')

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
