// `ui-chat` 宿主装配 + HTTP E2E（黑盒，经 boot CLI）：
// pack 冒烟 → 临时 root seed（ui-chat + input）→ start → 轮询 loaded →
// 子应用 HTTP（/entry.js 与静态模块 200、/events 开流、/api/command chat.history 预期
// unknown_command 错误占位且不崩、input.read 真实往返、question.answer 写槽后结构化失败）→
// stop → verify + replay。
// 失败路径同样 stop；用法：node plugins/ui-chat/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const CHAT_DIR = join(REPO_ROOT, 'plugins', 'ui-chat')
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

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-chat-e2e-${stamp}`)
  const packRoot = join(tmpdir(), 'kilo', `chrono-ui-chat-pack-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  mkdirSync(join(packRoot, 'state'), { recursive: true })
  const port = await freePort()
  const env = { ...process.env, CHRONO_UI_PORT_UI_CHAT: String(port) }
  let started = false
  try {
    // 入世冒烟：单目录 pack
    const packed = boot(packRoot, ['pack', CHAT_DIR, '--identity', 'ui-chat'])
    assert.equal(packed.ok, true, `pack 报告 ok:false：${JSON.stringify(packed)}`)
    console.log(`pack: status=${packed.status} commit=${packed.commitHash}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'ui-chat', path: CHAT_DIR },
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
      return status.loaded.some((item) => item.id === 'ui-chat')
    }, 'ui-chat loaded')
    console.log('start + 握手：ok（ui-chat 已装载）')

    // 等子应用 HTTP 就绪 + 入站连接建立
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

    // 入口与静态模块
    const entry = await httpCall(port, 'GET', '/entry.js')
    assert.equal(entry.status, 200)
    assert.match(entry.body, /export async function mount/)
    assert.match(String(entry.headers['content-type']), /javascript/)
    for (const name of ['markdown.js', 'sanitize.js', 'render-parts.js', 'tool-card.js', 'detail-renderers.js', 'entry.js']) {
      const response = await httpCall(port, 'GET', `/${name}`)
      assert.equal(response.status, 200, `${name} 应 200`)
    }
    const traversal = await httpCall(port, 'GET', '/../plugin.json')
    assert.equal(traversal.status, 404)
    console.log('HTTP 静态模块：ok（entry.js + 视图层模块 200、穿越 404）')

    // chat.history 不可用：结构化错误、不崩
    const history = await httpCall(port, 'POST', '/api/command', { name: 'chat.history', args: {} })
    assert.equal(history.status, 502, history.body)
    assert.equal(JSON.parse(history.body).code, 'unknown_command', history.body)
    const afterHistory = await httpCall(port, 'GET', '/api/state')
    assert.equal(afterHistory.status, 200)
    console.log('chat.history 不可用：ok（unknown_command 错误占位，进程未崩）')

    // input.read 真实往返（输入插件已 seed）
    const read = await httpCall(port, 'POST', '/api/command', { name: 'input.read', args: null })
    assert.equal(read.status, 200, read.body)
    assert.equal(JSON.parse(read.body).ok, true, read.body)
    console.log('入站桥往返：ok（input.read 经宿主返回）')

    // 资产：坏 sha256 → bad_asset
    const badAsset = await httpCall(port, 'GET', '/api/asset?sha256=zzz')
    assert.equal(badAsset.status, 400, badAsset.body)
    console.log('资产门禁：ok（坏 sha256 → 400）')

    // question.answer 路径：写槽成功但命令不可用 → 结构化失败、不崩
    const answer = await httpCall(port, 'POST', '/api/question/answer', {
      id: 'q-1',
      answers: [{ question_id: 'q1', selected: ['A'] }],
      thread: '_main',
    })
    assert.equal(answer.status, 502, answer.body)
    const answerBody = JSON.parse(answer.body)
    assert.equal(answerBody.wrote, true, answer.body)
    assert.equal(answerBody.code, 'unknown_command', answer.body)
    console.log('question.answer：ok（写槽成功、命令不可用结构化失败）')

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
