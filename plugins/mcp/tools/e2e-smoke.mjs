// `mcp` 宿主装配 E2E（黑盒，经 boot CLI + 协议直连本服务）：
// 临时 root → seed → boot start → 轮询 loaded → 声明命令核对
// → 直连本服务（CHRONO_PLUGIN_DATA 指向宿主 ④ 目录）write 服务器清单 + discover
// → 断言清单落 ④ 追加日志、无世界写计划；stop → verify + replay
// → 离线读投影确认 mcp 身份无运行记录 body（清单已出世界）。
// 失败路径也 stop，释放单写者锁。
// 用法：node plugins/mcp/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
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
const MCP_DIR = join(REPO_ROOT, 'plugins', 'mcp')
const SECRETS_DIR = join(REPO_ROOT, 'plugins', 'secrets')
const FAKE_SERVER = join(MCP_DIR, 'test', 'fake-mcp-server.mjs')

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

/** 直连本服务（注入 CHRONO_PLUGIN_DATA）：write 清单 → discover → read，返回结果与事件。 */
function driveService(dataDir, body) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, ['execute/main.ts'], {
      cwd: MCP_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CHRONO_PLUGIN_DATA: dataDir },
    })
    const decoder = createDecoder()
    const pending = new Map()
    const events = []
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error('mcp 服务调用超时'))
    }, 15000)
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
      await request('hello', { impl: 'mcp', gen: 'e2e' }, 'manifest')
      const written = await request(
        'call',
        { port: 'mcp', method: 'write', args: { body }, env: { run: 'e2e-run', thread: null, now: 0 } },
        'result',
      )
      const discovered = await request(
        'call',
        { port: 'mcp', method: 'discover', args: {}, env: { run: 'e2e-run', thread: null, now: 0 } },
        'result',
      )
      const read = await request(
        'call',
        { port: 'mcp', method: 'read', args: {}, env: { run: 'e2e-run', thread: null, now: 0 } },
        'result',
      )
      clearTimeout(timer)
      child.stdin.end()
      resolveCall({ written: written.value, discovered: discovered.value, read: read.value, events })
    })().catch((err) => {
      clearTimeout(timer)
      child.kill()
      rejectCall(err)
    })
  })
}

function serverEntry() {
  return {
    id: 'fake',
    command: process.execPath,
    args: [FAKE_SERVER, '--mode=ok'],
    confirmed: true,
  }
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-mcp-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  let started = false
  try {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        // pins 解析依赖 secrets active：seed 按清单顺序处理，依赖方在后
        { name: 'secrets', path: SECRETS_DIR },
        { name: 'mcp', path: MCP_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'])
      return status.loaded.some((item) => item.id === 'mcp')
    }, 'mcp loaded')
    console.log('start + 握手：ok')

    const commands = boot(root, ['commands'])
    for (const name of ['mcp.in.ping', 'mcp.in.tools_list', 'mcp.in.tools_call']) {
      assert.ok(
        commands.some((item) => item.name === name && item.identity === 'mcp'),
        `入站命令未声明：${name}`,
      )
    }
    console.log('入站命令声明：ok')

    const listResult = boot(root, [
      'mcp.in.tools_list',
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    ])
    assert.equal(listResult.status, 'done')
    assert.deepEqual(listResult.observations[0].value.result.tools, [])
    const callResult = boot(root, [
      'mcp.in.tools_call',
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'x' } }),
    ])
    assert.equal(callResult.observations[0].value.error.message, 'not_available_in_v1')
    console.log('入站 v1 最小能力面：ok')

    // 清单出世界：直连本服务写清单 + discover，落 ④ 追加日志。
    const paths = hostPaths(root)
    const dataDir = join(paths.dataDir, 'mcp')
    const { written, discovered, read, events } = await driveService(dataDir, {
      version: 1,
      servers: [serverEntry()],
      tools: [],
    })
    assert.equal(written.ok, true, 'write 未成功')
    assert.equal(discovered.$directives.length, 1, 'discover 应只回 extern（无世界写计划）')
    assert.equal(discovered.$directives[0].kind, 'extern')
    assert.equal(discovered.$directives[0].payload.changed, true)
    assert.equal(read.servers[0].id, 'fake')
    assert.deepEqual(
      read.tools.map((tool) => tool.name).sort(),
      ['mcp.fake.add', 'mcp.fake.boom', 'mcp.fake.echo'],
    )
    const echo = read.tools.find((tool) => tool.name === 'mcp.fake.echo')
    assert.equal(echo.intent, '回显输入文本')
    assert.equal(echo.boundaries, '由外部 MCP 服务器定义')
    assert.equal(echo.render.detail.kind, 'json')
    assert.ok(events.some((event) => event.topic === 'mcp.server' && event.payload.event === 'discovered'))
    const logFile = join(dataDir, 'mcp.jsonl')
    assert.equal(existsSync(logFile), true, '④ 追加日志应存在')
    const records = readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(records.some((record) => record.t === 'body' && record.run === 'e2e-run'))
    console.log('清单出世界：write/discover/read 往返 + ④ 追加日志 ok')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.ok(replayed !== null && (replayed.ok === true || replayed.head !== undefined), `replay 失败：${JSON.stringify(replayed)}`)
    console.log('verify + replay：ok')

    // 离线读投影：mcp 身份无运行记录 body（清单已出世界）。
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const body = projection.ids.mcp?.body
    assert.equal(body === undefined || body === null || body.servers === undefined, true, 'mcp 清单不应进世界')
    console.log('离线投影：mcp 清单未进世界 ok')

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
