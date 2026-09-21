// `tool-http` 宿主装配 E2E（黑盒，离线）：
// pack sandbox 替身 + tool-http → seed → start → 轮询 loaded → 直连服务 stdio（把 port.call
// 桥接到注入的假后端）→ describe / websearch / webfetch / net_denied → stop → verify + replay
// → 离线读投影确认 pins。
//
// 说明：真实 sandbox 是 Rust 实现、首跑需 cargo 编译且可能触网，故这里用 tools/fixtures/sandbox
// 的数据身份替身满足 pins；网络出口用注入的假后端，不真实触网。
// 失败路径也 stop，释放单写者锁。
// 用法：node plugins/tool-http/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
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
const TOOL_HTTP_DIR = join(REPO_ROOT, 'plugins', 'tool-http')
const SANDBOX_STUB = join(HERE, 'fixtures', 'sandbox')

const DDG_HTML =
  '<div class="result"><a class="result__a" href="https://one.test/page">One</a>' +
  '<a class="result__snippet">snip one</a></div>'

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

function argValue(args, flag) {
  if (!Array.isArray(args)) return null
  const index = args.indexOf(flag)
  return index === -1 ? null : (args[index + 1] ?? null)
}

function fetcherStdout({ status = 200, contentType = 'text/html', body = '' } = {}) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const meta = JSON.stringify({ status, content_type: contentType, url: '', truncated: false, body_encoding: 'base64' })
  return `${meta}\n${buffer.toString('base64')}`
}

function execValue(stdout) {
  return { exit_code: 0, stdout, stderr: '', truncated: false, duration_ms: 1 }
}

/** 假后端桥：应答服务的 port.call，记录调用。 */
function makeBridge() {
  const calls = []
  return {
    calls,
    handler(message) {
      calls.push(message)
      const url = argValue(message.args && message.args.args, '--url')
      if (message.port === 'sandbox' && message.method === 'exec') {
        if (typeof url === 'string' && url.includes('denied.test')) {
          return { ok: false, code: 'net_denied', message: 'declared net exceeds tier net' }
        }
        if (typeof url === 'string' && url.includes('bin.test')) {
          return {
            ok: true,
            value: execValue(fetcherStdout({ contentType: 'application/octet-stream', body: Buffer.from([0, 1, 2, 3]) })),
          }
        }
        return { ok: true, value: execValue(fetcherStdout({ contentType: 'text/html', body: DDG_HTML })) }
      }
      if (message.port === 'host' && message.method === 'asset.put') {
        return { ok: true, value: { kind: 'asset', sha256: 'cd'.repeat(32), mime: message.args.mime, size: 4 } }
      }
      return { ok: false, code: 'unresolved_cap', message: `no bridge for ${message.port}.${message.method}` }
    },
  }
}

/** 直连服务：hello → 方法调用；port.call 交给 bridge。 */
function startClient(bridge) {
  const child = spawn(process.execPath, ['execute/main.ts'], {
    cwd: TOOL_HTTP_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const decoder = createDecoder()
  const pending = new Map()
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      if (message.kind === 'port.call') {
        Promise.resolve()
          .then(() => bridge.handler(message))
          .then((outcome) => {
            const frame = outcome.ok
              ? { v: '1', id: message.id, kind: 'port.result', ok: true, value: outcome.value }
              : { v: '1', id: message.id, kind: 'port.error', ok: false, error: outcome.code, message: outcome.message }
            child.stdin.write(encodeFrame(frame))
          })
          .catch((err) => {
            child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'bridge_failed', message: err.message }))
          })
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
  function request(kind, fields) {
    seq += 1
    const id = `e2e-${seq}`
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => rejectRequest(new Error(`timeout waiting ${kind}`)), 15000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }
  function close() {
    child.stdin.end()
    return new Promise((resolveExit) => child.once('exit', resolveExit))
  }
  return { request, close, child }
}

async function waitForLoaded(root) {
  const deadline = Date.now() + 30000
  for (;;) {
    const status = boot(root, ['status'])
    if (status.loaded.some((item) => item.id === 'tool-http')) return status
    if (Date.now() > deadline) throw new Error(`tool-http 未装载：${JSON.stringify(status.loaded)}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
  }
}

async function directChecks() {
  const bridge = makeBridge()
  const client = startClient(bridge)
  try {
    const manifest = await client.request('hello', { impl: 'tool-http', gen: 'e2e' })
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.identity, 'tool-http')
    assert.deepEqual(manifest.implements, ['tool-http'])

    const described = await client.request('call', { port: 'tool-http', method: 'describe', args: {} })
    assert.deepEqual(described.value.tools.map((tool) => tool.name), ['websearch', 'webfetch'])
    console.log('describe：两工具四要素齐备')

    const search = await client.request('call', {
      port: 'tool-http',
      method: 'invoke',
      args: {
        tool: 'websearch',
        args: { query: 'chrono' },
        config: {
          obey_robots: false,
          sources: [
            { id: 's', name: 'S', kind: 'html', parse: 'ddg-html', endpoint: 'https://s.test/search', query_param: 'q', timeout_ms: 1000 },
          ],
        },
        tier: 'auto',
        workspace_root: 'C:/ws',
        caps: { fs: { read: 'none', write: 'none' }, net: 'limited' },
      },
    })
    assert.equal(search.value.ok, true)
    assert.deepEqual(search.value.result.sources_used, ['S'])
    assert.equal(search.value.result.results[0].url, 'https://one.test/page')
    console.log('websearch：经反向调用合并结果')

    const binary = await client.request('call', {
      port: 'tool-http',
      method: 'invoke',
      args: { tool: 'webfetch', args: { url: 'https://bin.test/f' }, config: { obey_robots: false }, tier: 'auto' },
    })
    assert.equal(binary.value.ok, true)
    assert.equal(binary.value.result.asset.kind, 'asset')
    console.log('webfetch：二进制经 host.asset.put 存资产')

    const denied = await client.request('call', {
      port: 'tool-http',
      method: 'invoke',
      args: { tool: 'webfetch', args: { url: 'https://denied.test/' }, config: { obey_robots: false }, tier: 'auto' },
    })
    assert.equal(denied.value.ok, false)
    assert.equal(denied.value.error.code, 'net_denied')
    console.log('net_denied：按档钳制结果透传')

    const execCalls = bridge.calls.filter((call) => call.port === 'sandbox' && call.method === 'exec')
    assert.ok(execCalls.length >= 3)
    assert.ok(execCalls.some((call) => call.args.caps.net === 'limited'))
    assert.ok(execCalls.some((call) => call.args.caps.net === 'all'))
    assert.ok(bridge.calls.some((call) => call.port === 'host' && call.method === 'asset.put'))
    return manifest
  } finally {
    await client.close()
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-tool-http-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'sandbox', path: SANDBOX_STUB },
        { name: 'tool-http', path: TOOL_HTTP_DIR },
      ]),
    )
    const packedSandbox = boot(root, ['pack', SANDBOX_STUB, '--identity', 'sandbox'])
    assert.equal(packedSandbox.ok, true, 'pack sandbox 替身报告 ok:false')
    const packedTool = boot(root, ['pack', TOOL_HTTP_DIR, '--identity', 'tool-http'])
    assert.equal(packedTool.ok, true, 'pack tool-http 报告 ok:false')
    console.log(`pack：sandbox=${packedSandbox.status} tool-http=${packedTool.status}`)

    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed：${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    const status = await waitForLoaded(root)
    console.log('start + 握手 + loaded：ok')

    await directChecks()

    const afterStatus = boot(root, ['status'])
    assert.deepEqual(afterStatus.world_head, status.world_head, '反向调用不应写世界')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterStatus.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    assert.deepEqual(projection.ids['tool-http'].pins, { sandbox: 'sandbox', host: 'host' })
    assert.deepEqual(projection.ids.sandbox.pins, {})
    console.log('离线投影：tool-http.pins = { sandbox, host }')

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
