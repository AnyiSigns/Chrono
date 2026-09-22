// `ui-threads` 宿主装配 E2E（黑盒，经 boot CLI）：
// pack 冒烟（并从入世源码树核验 `.worldignore`）→ 临时 root seed（ui-threads + session + todo + input）→
// start → 轮询 loaded → 子应用 HTTP（/entry.js 与视图层模块 200、穿越 404）→
// 只读命令 `threads.state` 真实往返 → 宿主事件经本插件 SSE 转发 → stop → verify + replay。
// 失败路径同样 stop；用法：node plugins/ui-threads/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const THREADS_DIR = join(REPO_ROOT, 'plugins', 'ui-threads')
const SESSION_DIR = join(REPO_ROOT, 'plugins', 'session')
const TODO_DIR = join(REPO_ROOT, 'plugins', 'todo')
const INPUT_DIR = join(REPO_ROOT, 'plugins', 'input')

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

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function httpCall(port, method, path, body) {
  return new Promise((resolveCall, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    const headers = payload === null ? {} : { 'content-type': 'application/json', 'content-length': payload.length }
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () =>
        resolveCall({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
    req.on('error', reject)
    if (payload !== null) req.write(payload)
    req.end()
  })
}

/** 打开 SSE 流：`ready` 在响应到达时兑现，`result` 在匹配 predicate 的记录出现时兑现。 */
function openSse(port, predicate, timeoutMs = 10000) {
  let markReady
  const ready = new Promise((resolveReady) => {
    markReady = resolveReady
  })
  const result = new Promise((resolveResult, reject) => {
    const req = httpGet({ host: '127.0.0.1', port, path: '/events' }, (res) => {
      markReady()
      let buffer = ''
      const timer = setTimeout(() => {
        req.destroy()
        reject(new Error(`SSE 超时；已收到：${buffer.slice(0, 800)}`))
      }, timeoutMs)
      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const records = buffer
          .split('\n\n')
          .map((part) => {
            const line = part.split('\n').find((entry) => entry.startsWith('data: '))
            if (line === undefined) return null
            try {
              return JSON.parse(line.slice('data: '.length))
            } catch {
              return null
            }
          })
          .filter((record) => record !== null)
        const found = records.find(predicate)
        if (found !== undefined) {
          clearTimeout(timer)
          req.destroy()
          resolveResult({ records, found })
        }
      })
      res.on('error', () => {})
    })
    req.on('error', reject)
  })
  return { ready, result }
}

async function waitFor(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`)
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
  }
}

/** 从 journal 收集所有 def body（顶层 put 与 batch 子操作的 put）。 */
function journalBodies(journalPath) {
  let text = ''
  try {
    text = readFileSync(journalPath, 'utf8')
  } catch {
    return []
  }
  const bodies = []
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (entry.op === 'put' && entry.args !== null && typeof entry.args === 'object') {
      bodies.push(entry.args.body)
    }
    if (entry.op === 'batch' && entry.args !== null && typeof entry.args === 'object' && Array.isArray(entry.args.ops)) {
      for (const op of entry.args.ops) {
        if (op.op === 'put' && op.args !== null && typeof op.args === 'object') bodies.push(op.args.body)
      }
    }
  }
  return bodies
}

/** 核验 `.worldignore`：入世源码树的根 tree 不含 `test/` / `tools/`，含 `execute/` / `terms/`。 */
function assertWorldignoreExcludes(journalPath) {
  const rootTrees = journalBodies(journalPath).filter(
    (body) =>
      body !== null &&
      typeof body === 'object' &&
      Array.isArray(body.entries) &&
      body.entries.some((entry) => entry.name === 'plugin.json'),
  )
  assert.ok(rootTrees.length > 0, '入世源码树里找不到根 tree（plugin.json）')
  for (const tree of rootTrees) {
    const names = tree.entries.map((entry) => entry.name)
    assert.equal(names.includes('test'), false, `根 tree 不应含 test/：${names.join(',')}`)
    assert.equal(names.includes('tools'), false, `根 tree 不应含 tools/：${names.join(',')}`)
    assert.ok(names.includes('execute'), '根 tree 应含 execute/')
    assert.ok(names.includes('terms'), '根 tree 应含 terms/')
  }
  return rootTrees[0].entries.length
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-threads-e2e-${stamp}`)
  const packRoot = join(tmpdir(), 'kilo', `chrono-ui-threads-pack-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(packRoot, 'state'), { recursive: true })
  const port = await freePort()
  const env = { ...process.env, CHRONO_UI_PORT_UI_THREADS: String(port) }
  let started = false
  try {
    // 入世冒烟：单目录 pack + `.worldignore` 核验
    const packed = boot(packRoot, ['pack', THREADS_DIR, '--identity', 'ui-threads'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    const entries = assertWorldignoreExcludes(join(packRoot, 'state', 'world', 'journal.jsonl'))
    console.log(`pack: status=${packed.status} commit=${packed.commitHash}；.worldignore 生效（根 tree ${entries} 项，无 test/ 与 tools/）`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'ui-threads', path: THREADS_DIR },
        { name: 'session', path: SESSION_DIR },
        { name: 'todo', path: TODO_DIR },
        { name: 'input', path: INPUT_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'], env)
    started = true

    await waitFor(() => {
      const status = boot(root, ['status'], env)
      const loaded = status.loaded.map((item) => item.id)
      return ['ui-threads', 'session', 'todo', 'input'].every((id) => loaded.includes(id))
    }, 'ui-threads + session + todo + input loaded')
    console.log('start + 握手：ok（ui-threads / session / todo / input 已装载）')

    const stateDeadline = Date.now() + 20000
    for (;;) {
      try {
        const response = await httpCall(port, 'GET', '/api/state')
        const state = JSON.parse(response.body)
        if (state.ok === true && state.connected === true) break
      } catch {
        // 尚未监听
      }
      if (Date.now() > stateDeadline) throw new Error(`timeout: 子应用 /api/state connected（port=${port}）`)
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 200))
    }
    console.log('子应用 HTTP + 入站连接：ok')

    const entry = await httpCall(port, 'GET', '/entry.js')
    assert.equal(entry.status, 200)
    assert.match(entry.body, /export async function mount/)
    assert.match(String(entry.headers['content-type']), /javascript/)
    for (const name of ['threads-model.js', 'hover-intent.js', 'unread.js', 'bridge-state.js', 'entry.js']) {
      const response = await httpCall(port, 'GET', `/${name}`)
      assert.equal(response.status, 200, `${name} 应 200`)
    }
    const traversal = await httpCall(port, 'GET', '/../plugin.json')
    assert.equal(traversal.status, 404)
    console.log('HTTP 静态模块：ok（entry.js + 视图层模块 200、穿越 404）')

    // 只读命令 `threads.state`：入口 term 投影读 → 自能力路由 → 服务装配（初始无会话：空标签、不崩）
    const state = await httpCall(port, 'POST', '/api/command', { name: 'threads.state', args: null })
    assert.equal(state.status, 200, state.body)
    const value = JSON.parse(state.body).value
    assert.equal(value.ok, true, state.body)
    assert.ok(Array.isArray(value.tags), state.body)
    console.log(`threads.state：ok（标签 ${value.tags.length} 个，current=${JSON.stringify(value.current)}）`)

    // SSE：宿主 run 事件经本插件转发（input.read 命令 run）
    const sse = openSse(port, (record) => record.topic === 'run.started' || record.topic === 'run.finished')
    await sse.ready
    await httpCall(port, 'POST', '/api/command', { name: 'input.read', args: null })
    const sseResult = await sse.result
    assert.equal(sseResult.found.impl, 'host')
    console.log(`SSE：ok（收到宿主事件 ${sseResult.found.topic}）`)

    const status = boot(root, ['status'], env)
    boot(root, ['stop'], env)
    started = false

    const verified = boot(root, ['verify'], env)
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'], env)
    assert.deepEqual(replayed.head, status.world_head, 'replay 链头与 status 不一致')
    console.log('verify + replay：ok')

    console.log(`E2E ok（root=${root}，port=${port}）`)
  } finally {
    if (started) {
      try {
        boot(root, ['stop'], env)
      } catch (err) {
        console.error(`stop 失败：${err.message}`)
      }
    }
    rmSync(packRoot, { recursive: true, force: true })
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (err) {
      console.error(`清理临时 root 失败（不影响结果）：${err.message}`)
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
