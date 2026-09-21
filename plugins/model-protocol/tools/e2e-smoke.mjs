// `model-protocol` 宿主装配 E2E（离线，不触真实网络）：
// 临时 root → seed（secrets / config / model-protocol）→ start → 直连服务驱动
// chat（本地假模型端点 + 假 secrets.resolve）→ discover → profile（本地假 models.dev 源）
// → 计划经 `boot run` 落账 → stop → verify + replay → 离线读投影确认 config 元数据。
// 失败路径也 stop，释放单写者锁。
// 用法：node plugins/model-protocol/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
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
const MODEL_DIR = join(REPO_ROOT, 'plugins', 'model-protocol')
const SECRETS_DIR = join(REPO_ROOT, 'plugins', 'secrets')
const CONFIG_DIR = join(REPO_ROOT, 'plugins', 'config')

const SECRET_VALUE = 'e2e-secret-value'

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], { encoding: 'utf8', cwd: REPO_ROOT })
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

/** 直连本服务：hello → call，收集 event，并自动应答反向 port.call（模拟宿主侧路由）。 */
function callMethod(method, args) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, ['execute/main.ts'], { cwd: MODEL_DIR, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHRONO_PLUGIN_STATE: '' } })
    const decoder = createDecoder()
    const pending = new Map()
    const events = []
    const portCalls = []
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error(`方法 ${method} 超时`))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'event') {
          events.push(message)
          continue
        }
        if (message.kind === 'port.call') {
          portCalls.push(message)
          child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: SECRET_VALUE }))
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
            rejectRequest(new Error(`expected ${expect} got ${message.kind}: ${JSON.stringify(message)}`))
            return
          }
          resolveRequest(message)
        })
        child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
      })
    }
    ;(async () => {
      await request('hello', { impl: 'model-protocol', gen: 'e2e' }, 'manifest')
      const result = await request('call', { port: 'model', method, args, env: { run: 'e2e-run', thread: null, now: 0 } }, 'result')
      clearTimeout(timer)
      child.stdin.end()
      resolveCall({ value: result.value, events, portCalls })
    })().catch((err) => {
      clearTimeout(timer)
      child.kill()
      rejectCall(err)
    })
  })
}

/** 本地假模型端点：三协议只用到 openai-chat + /models + /api.json（models.dev 源）。 */
function startModelServer() {
  return new Promise((resolveServer) => {
    const server = http.createServer((req, res) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        if (req.method === 'GET' && req.url === '/models') {
          const body = JSON.stringify({ data: [{ id: 'gpt-test' }, { id: 'gpt-other' }, { id: 'models/gpt-test' }] })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
          return
        }
        if (req.method === 'GET' && req.url === '/api.json') {
          const body = JSON.stringify({
            openai: {
              models: {
                'gpt-test': { limit: { context: 128000, output: 16384 }, reasoning: true, modalities: { input: ['text'], output: ['text'] } },
              },
            },
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
          return
        }
        if (req.method === 'POST' && req.url === '/chat/completions') {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          const send = (payload) => res.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
          send({ choices: [{ delta: { content: 'E2E' } }] })
          send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_e2e', function: { name: 'ping', arguments: '{}' } }] } }] })
          send({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
          send('[DONE]')
          res.end()
          return
        }
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveServer({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

const QUIRKS = {
  impl: 'protocol',
  protocol: 'openai-chat',
  auth_style: 'bearer',
  system_role: 'system',
  reasoning_field: 'reasoning_effort',
  reasoning_map: { low: 'low', high: 'high' },
  reasoning_response_field: 'reasoning_content',
  max_tokens_field: 'max_tokens',
  models_path: '/models',
  stream_usage: 'final_chunk',
  extra_headers: {},
}

const VENDOR_BODY = {
  sdk: 'openai',
  default_base_url: 'https://api.openai.com/v1',
  default_auth_ref_name: 'OPENAI_API_KEY',
  default_reasoning: ['low', 'medium', 'high'],
}

function e2eConfig(baseUrl) {
  return {
    version: 1,
    providers: {
      openai: {
        base_url: baseUrl,
        auth_ref: { kind: 'local', name: 'OPENAI_API_KEY' },
        models: { 'gpt-test': { name: 'GPT Test', enabled: true } },
      },
    },
  }
}

function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolveWait, rejectWait) => {
    const tick = () => {
      if (predicate()) return resolveWait()
      if (Date.now() > deadline) return rejectWait(new Error(`timeout: ${label}`))
      setTimeout(tick, 150)
    }
    tick()
  })
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-model-protocol-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  const modelServer = await startModelServer()
  let started = false
  try {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'secrets', path: SECRETS_DIR },
        { name: 'config', path: CONFIG_DIR },
        { name: 'model-protocol', path: MODEL_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    await waitFor(() => boot(root, ['status']).loaded.some((item) => item.id === 'model-protocol'), 'model-protocol loaded')
    console.log('start + 握手：ok')

    // chat：本地假端点 + 假 secrets.resolve；断言分片与最终值，明文不出现在结果 / 事件。
    const chat = await callMethod('chat', {
      config: { base_url: modelServer.url, auth_ref: { kind: 'local', name: 'OPENAI_API_KEY' }, model: 'gpt-test', params: { max_tokens: 32, reasoning: 'low' }, quirks: QUIRKS },
      messages: [{ role: 'user', content: 'hi' }],
      resilience: { max_retries: 0 },
    })
    assert.equal(chat.value.ok, true)
    assert.equal(chat.value.text, 'E2E')
    assert.deepEqual(chat.value.tool_calls, [{ id: 'call_e2e', name: 'ping', arguments: {} }])
    assert.equal(JSON.stringify(chat.value).includes(SECRET_VALUE), false, '明文不得进结果')
    assert.equal(JSON.stringify(chat.events).includes(SECRET_VALUE), false, '明文不得进事件')
    assert.ok(chat.portCalls.some((call) => call.port === 'secrets' && call.method === 'resolve'))
    assert.ok(chat.events.some((event) => event.topic === 'model.delta' && event.payload.text === 'E2E'))
    console.log(`chat：ok（${chat.events.filter((event) => event.topic === 'model.delta').length} 个分片）`)

    // discover：规范化模型 id 列表。
    const discover = await callMethod('discover', { url: modelServer.url, auth_ref: { kind: 'local', name: 'OPENAI_API_KEY' } })
    assert.deepEqual(discover.value.models, ['gpt-other', 'gpt-test'])
    console.log('discover：ok')

    // profile：拉本地假 models.dev 源 → 产写计划。
    const profile = await callMethod('profile', {
      vendor: 'vendor-openai',
      ids: ['gpt-test'],
      config: e2eConfig(modelServer.url),
      vendors: { 'vendor-openai': VENDOR_BODY },
      source_url: `${modelServer.url}/api.json`,
    })
    const directives = profile.value.$directives
    assert.equal(directives.length, 2, 'profile 应回 batch + extern')
    assert.equal(directives[0].kind, 'write')
    assert.equal(directives[0].request.op, 'batch')
    const ops = directives[0].request.args.ops
    assert.equal(ops[0].op, 'put')
    assert.equal(ops[1].args.id, 'config')
    console.log('profile 写计划：ok')

    const before = boot(root, ['status'])
    const landed = boot(root, ['run', JSON.stringify(directives)])
    assert.equal(landed.status, 'done', `计划落账未完成：${JSON.stringify(landed)}`)
    const after = boot(root, ['status'])
    assert.notDeepEqual(after.world_head, before.world_head, '落账后链头应推进')
    console.log('计划落账：done')

    boot(root, ['stop'])
    started = false

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'])
    assert.deepEqual(replayed.head, after.world_head, 'replay 链头与落账后 status 不一致')
    console.log('verify + replay：ok')

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    const model = projection.ids.config.body.providers.openai.models['gpt-test']
    assert.equal(model.context_window, 128000)
    assert.equal(model.max_output, 16384)
    assert.deepEqual(model.reasoning, ['low', 'medium', 'high'])
    assert.deepEqual(model.modalities, { input: ['text'], output: ['text'] })
    assert.equal(model.name, 'GPT Test')
    console.log('离线投影：config 模型元数据正确')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    await modelServer.close()
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
