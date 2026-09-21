// `mcp` 宿主装配 E2E（黑盒，经 boot CLI + 协议直连本服务）：
// 临时 root → seed → boot start → 轮询 loaded → seed 默认 body（空清单）
// → 协议直连驱动 discover（bag.servers = 含测试 MCP 服务器的整份 body）
// → 返回计划经 `boot run` 落账 → stop → verify + replay
// → 离线读投影确认 ids.mcp.body.tools 的命名空间化工具清单与 render。
// 失败路径也 stop，释放单写者锁。
// 用法：node plugins/mcp/tools/e2e-smoke.mjs
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
const MCP_DIR = join(REPO_ROOT, 'plugins', 'mcp')
const SECRETS_DIR = join(REPO_ROOT, 'plugins', 'secrets')
const SEED_SCRIPT = join(MCP_DIR, 'tools', 'seed-default-body.mjs')
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

function runSeedBody(root) {
  const result = spawnSync(process.execPath, [SEED_SCRIPT, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
  if (result.status !== 0) {
    throw new Error(`seed 脚本失败（exit ${result.status}）：${result.stderr || result.stdout}`)
  }
  return JSON.parse(result.stdout.trim())
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

/** 直连本服务：hello → call discover，收集 event，返回结果值。 */
function callDiscover(bag) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, ['execute/main.ts'], {
      cwd: MCP_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
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
      const result = await request(
        'call',
        {
          port: 'mcp',
          method: 'discover',
          args: bag,
          env: { run: 'e2e-run', thread: null, now: 0 },
        },
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

function serverEntry() {
  return {
    id: 'fake',
    command: process.execPath,
    args: [FAKE_SERVER, '--mode=ok'],
    confirmed: true,
  }
}

function discoverBag(servers) {
  return { servers: { version: 1, servers, tools: [] } }
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

    // 入站 v1 最小能力面：入口 term 经宿主命令面返回 MCP 形状信封
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

    const seededBody = runSeedBody(root)
    assert.equal(seededBody.ok, true, 'seed 脚本报告 ok:false')
    console.log(`seed 默认 body：${seededBody.status}`)

    const beforeStatus = boot(root, ['status'])
    const { value, events } = await callDiscover(discoverBag([serverEntry()]))
    const directives = value.$directives
    assert.equal(directives.length, 2, 'discover 应回 batch + extern')
    assert.equal(directives[0].kind, 'write')
    assert.equal(directives[0].request.op, 'batch')
    const ops = directives[0].request.args.ops
    assert.equal(ops[0].op, 'put')
    assert.equal(ops[1].op, 'add_gen')
    assert.equal(ops[1].args.id, 'mcp')
    assert.ok(events.some((event) => event.topic === 'mcp.server' && event.payload.event === 'discovered'))
    console.log(`discover 计划：${ops.length} ops + extern`)

    const landed = boot(root, ['run', JSON.stringify(directives)])
    assert.equal(landed.status, 'done', `计划落账未完成：${JSON.stringify(landed)}`)
    console.log('计划落账：done')

    const afterStatus = boot(root, ['status'])
    assert.notDeepEqual(afterStatus.world_head, beforeStatus.world_head, '落账后链头应推进')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, afterStatus.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    // 离线读投影：ids.mcp.body 的工具清单
    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const body = projection.ids.mcp.body
    assert.equal(body.version, 1)
    assert.equal(body.servers[0].id, 'fake')
    assert.equal(body.servers[0].connected, undefined, '易变运行态不得写回 body')
    assert.equal(body.servers[0].tool_count, undefined, '易变运行态不得写回 body')
    assert.equal(body.servers[0].confirmed, true)
    const names = body.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['mcp.fake.add', 'mcp.fake.boom', 'mcp.fake.echo'])
    const echo = body.tools.find((tool) => tool.name === 'mcp.fake.echo')
    assert.equal(echo.intent, '回显输入文本')
    assert.equal(echo.boundaries, '由外部 MCP 服务器定义')
    assert.equal(echo.render.detail.kind, 'json')
    assert.equal(echo.idempotent, false)
    console.log('离线投影：ids.mcp.body.tools 命名空间化工具清单正确')

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
