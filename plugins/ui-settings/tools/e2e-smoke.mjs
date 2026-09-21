// `ui-settings` 宿主装配 + HTTP E2E（黑盒，经 boot CLI）：
// pack 入世树核对 → 临时 root seed（配置 / 输入 / 技能 / 智能体 / 台账 / 厂商模板 / 密钥 /
// 模型协议 / ui-settings）→ start → 轮询 loaded → 子应用 HTTP（/entry.js 与静态模块 200、
// 穿越 404、只读命令真实往返、未就位依赖降级、技能直写、密钥直写、SSE）→ stop → verify + replay。
// 真实模型集成（`model.discover`）读仓库根 `.env` 的 base_url / model_id；缺失或失败优雅跳过。
// 失败路径同样尝试 stop 释放锁。用法：node plugins/ui-settings/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpGet, request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { packSourceDir, readWorldignore } from '../../../packages/host/assembly/source.ts'
import { extractValue } from '../execute/bridge.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const SETTINGS_DIR = join(REPO_ROOT, 'plugins', 'ui-settings')

/** 依赖先于本插件的 seed 顺序（pins 需在入世时解析到已存在的身份）。 */
const PACKAGES = [
  'config',
  'input',
  'skill',
  'agents',
  'evolution',
  'vendor-deepseek',
  'vendor-custom',
  'secrets',
  'model-protocol',
  'ui-settings',
]

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

/**
 * 本地假模型端点：`/models.dev.json` 回 models.dev 档案（供 `model.profile`），
 * 其余路径回模型列表（供 `model.discover`）。让四个服务侧命令在无外网下也可确定性断言。
 * 必须住独立进程：e2e 用 `spawnSync` 跑 boot（阻塞事件循环），同进程的 HTTP 服务无法应答。
 */
const FAKE_MODEL_SCRIPT = `
import { createServer } from 'node:http'
const port = Number(process.argv[2])
const server = createServer((req, res) => {
  const body = req.url === '/models.dev.json'
    ? { deepseek: { models: { 'e2e-model-a': { limit: { context: 128000, output: 8192 }, reasoning: true, modalities: { input: ['text'], output: ['text'] } } } } }
    : { data: [{ id: 'e2e-model-a' }, { id: 'e2e-model-b' }] }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})
server.listen(port, '127.0.0.1')
`

/** 起假模型端点子进程并等它就绪；返回子进程句柄。 */
async function startFakeModelServer(root, port) {
  const script = join(root, 'fake-model.mjs')
  writeFileSync(script, FAKE_MODEL_SCRIPT)
  const child = spawn(process.execPath, [script, String(port)], { stdio: 'ignore' })
  const deadline = Date.now() + 10000
  for (;;) {
    try {
      const response = await httpCall(port, 'GET', '/models.dev.json')
      if (response.status === 200) return child
    } catch {
      // 尚未监听
    }
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`timeout: 假模型端点未就绪（port=${port}）`)
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
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

/** 从打包子操作里收集树内文件路径（目录 put 的 entries；文件条目 hash 是真实哈希）。 */
function collectPackedPaths(ops, rootIndex) {
  const paths = []
  const walk = (index, prefix) => {
    const body = ops[index]?.args?.body
    const entries = body?.entries
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const name = entry?.name
      if (typeof name !== 'string') continue
      const path = prefix.length === 0 ? name : `${prefix}/${name}`
      if (entry.mode === 'dir' && entry.hash !== null && typeof entry.hash === 'object' && Number.isInteger(entry.hash.$n)) {
        walk(entry.hash.$n, path)
      } else if (entry.mode === 'file') {
        paths.push(path)
      }
    }
  }
  walk(rootIndex, '')
  return paths
}

/** 解析仓库根 `.env`：支持 `key=value` 与 `key:value`；缺失返回空表。 */
function readDotEnv() {
  const file = join(REPO_ROOT, '.env')
  if (!existsSync(file)) return {}
  const values = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const match = line.match(/^([A-Za-z0-9_]+)\s*[:=]\s*(.+)$/)
    if (match === null) continue
    if (values[match[1]] === undefined) values[match[1]] = match[2].trim().replace(/^["']|["']$/g, '')
  }
  return values
}

function writeSlotBody(threadKey, slot) {
  return {
    ops: [
      { op: 'put', args: { body: { slots: { [threadKey]: slot } } } },
      { op: 'add_gen', args: { id: 'input', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
    ],
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-ui-settings-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  const port = await freePort()
  const fakePort = await freePort()
  const fakeBase = `http://127.0.0.1:${fakePort}/v1`
  const fakeModel = await startFakeModelServer(root, fakePort)
  const env = {
    ...process.env,
    CHRONO_UI_PORT_UI_SETTINGS: String(port),
    CHRONO_MODELS_DEV_URL: `http://127.0.0.1:${fakePort}/models.dev.json`,
  }
  let started = false
  try {
    // 1) 入世树核对：契约文件与 execute/web/terms 入世，test/ 与 tools/ 排除。
    const worldignore = readWorldignore(SETTINGS_DIR)
    assert.equal(worldignore.ok, true, '.worldignore 解析失败')
    const source = packSourceDir(SETTINGS_DIR, worldignore.patterns)
    const packedPaths = collectPackedPaths(source.ops, source.rootTreeIndex)
    for (const required of [
      'plugin.json',
      'package.json',
      'README.md',
      'execute/main.ts',
      'execute/web/entry.js',
      'execute/web/config-model.js',
      'terms/model.discover.json',
      'terms/secrets.status.json',
      'terms/orchestration.health.json',
    ]) {
      assert.ok(packedPaths.includes(required), `入世树缺 ${required}`)
    }
    assert.ok(!packedPaths.some((path) => path.startsWith('test/')), '入世树含 test/')
    assert.ok(!packedPaths.some((path) => path.startsWith('tools/')), '入世树含 tools/')
    console.log(`入世树：ok（${packedPaths.length} 个文件，排除 test/ 与 tools/）`)

    // 2) seed（依赖先入世，pins 才解析得到）
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(PACKAGES.map((name) => ({ name, path: join(REPO_ROOT, 'plugins', name) })), null, 2),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, `seed 报告 ok:false：${JSON.stringify(seeded.items)}`)
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    // 3) start + 轮询 loaded
    boot(root, ['start'], env)
    started = true
    await waitFor(() => boot(root, ['status'], env).loaded.some((item) => item.id === 'ui-settings'), 'ui-settings loaded')
    const status = boot(root, ['status'], env)
    assert.ok(status.loaded.some((item) => item.id === 'ui-settings'), 'ui-settings 未出现在 loaded')
    console.log(`loaded: ${status.loaded.map((item) => item.id).join(' ')}`)

    // 4) 命令声明与属主
    const commands = boot(root, ['commands'], env)
    const health = commands.find((command) => command.name === 'orchestration.health')
    assert.ok(health, 'commands 缺 orchestration.health')
    assert.equal(health.identity, 'ui-settings')
    console.log('commands：ok（orchestration.health 属主 ui-settings）')

    // 4b) 写默认 body（数据世代）：config（含已保存厂商，供 model.profile）+
    //     两家厂商模板（供 model.vendors）；否则投影 body 回落到代码世代（无模板字段）。
    const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
    const configBody = {
      version: 1,
      params: {},
      permission: 'review',
      ui: { theme: 'system', style: '', sidebar_width: 260 },
      vendor: 'deepseek',
      model: 'e2e-model-a',
      providers: {
        deepseek: {
          name: 'DeepSeek',
          base_url: fakeBase,
          auth_ref: { kind: 'local', name: 'E2E_MODEL_KEY' },
          models: { 'e2e-model-a': { name: 'e2e-model-a', enabled: true } },
        },
      },
    }
    const defaultBodies = [
      ['config', configBody],
      ['vendor-deepseek', readJson(join(REPO_ROOT, 'plugins', 'vendor-deepseek', 'tools', 'default-body.json'))],
      ['vendor-custom', readJson(join(REPO_ROOT, 'plugins', 'vendor-custom', 'tools', 'default-body.json'))],
    ]
    const defaultOps = []
    for (const [id, body] of defaultBodies) {
      const index = defaultOps.length
      defaultOps.push({ op: 'put', args: { body } })
      defaultOps.push({ op: 'add_gen', args: { id, payload: { $n: index }, sig: { $n: index }, pins: {} } })
    }
    const configPos = boot(root, ['status'], env).world_head.hash
    const configWritten = boot(root, ['run', JSON.stringify([
      {
        kind: 'write',
        request: {
          id: 'e2e-default-bodies',
          op: 'batch',
          target: { expect_pos: configPos },
          args: { ops: defaultOps },
          by: 'e2e',
        },
      },
    ])], env)
    assert.equal(configWritten.status, 'done', `写默认 body 未完成：${JSON.stringify(configWritten)}`)
    console.log(`默认 body：done（${defaultBodies.map(([id]) => id).join(', ')}）`)

    // 5) 子应用 HTTP 就绪 + 入站连接
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

    // 6) 入口与静态模块 / 穿越
    const entry = await httpCall(port, 'GET', '/entry.js')
    assert.equal(entry.status, 200)
    assert.match(entry.body, /export async function mount/)
    assert.match(String(entry.headers['content-type']), /javascript/)
    for (const name of [
      'entry.js',
      'config-model.js',
      'onboarding.js',
      'notify.js',
      'health.js',
      'settings-model.js',
      'styles.js',
      'dom.js',
      'messages.js',
      'ui-parts.js',
      'version.js',
      'client.js',
      'provider-form.js',
      'provider-actions.js',
      'theme-actions.js',
      'notify-actions.js',
      'config-io.js',
      'data-load.js',
      'sse.js',
      'view-onboarding.js',
      'view-general.js',
      'view-model.js',
      'view-plugins.js',
      'view-skills.js',
      'view-memory.js',
      'view-orchestration.js',
      'view-about.js',
    ]) {
      const response = await httpCall(port, 'GET', `/${name}`)
      assert.equal(response.status, 200, `${name} 应 200`)
    }
    const traversal = await httpCall(port, 'GET', '/../plugin.json')
    assert.equal(traversal.status, 404)
    console.log('HTTP 静态模块：ok（视图层模块 200、穿越 404）')

    // 7) 只读命令真实往返
    const config = await httpCall(port, 'POST', '/api/command', { name: 'config.read', args: null })
    assert.equal(config.status, 200, config.body)
    assert.equal(JSON.parse(config.body).value.version, 1, config.body)

    const identities = await httpCall(port, 'POST', '/api/command', { name: 'settings.identities', args: null })
    assert.equal(identities.status, 200, identities.body)
    assert.ok(JSON.parse(identities.body).value['ui-settings'], identities.body)
    console.log('只读命令：ok（config.read / settings.identities 经宿主返回）')

    // 7b) 四个服务侧命令：命令结果 = 计划末尾 extern 载荷（`extractValue`，与浏览器桥同口径）。
    const vendors = extractValue(boot(root, ['model.vendors'], env))
    assert.equal(vendors.ok, true, `model.vendors 非成功结果：${JSON.stringify(vendors)}`)
    assert.ok(Array.isArray(vendors.vendors), `model.vendors 缺 vendors 列表：${JSON.stringify(vendors)}`)
    assert.ok(
      vendors.vendors.some((item) => item.identity === 'vendor-deepseek' && item.default_base_url === 'https://api.deepseek.com/v1'),
      `model.vendors 未命中 vendor-deepseek 模板：${JSON.stringify(vendors)}`,
    )
    assert.ok(vendors.vendors.some((item) => item.identity === 'vendor-custom'), `model.vendors 缺 vendor-custom：${JSON.stringify(vendors)}`)
    console.log(`model.vendors：ok（${vendors.vendors.length} 个模板：${vendors.vendors.map((item) => item.identity).join(', ')}）`)

    const profile = extractValue(boot(root, ['model.profile'], env))
    assert.equal(profile.ok, true, `model.profile 非成功结果：${JSON.stringify(profile)}`)
    assert.equal(profile.changed, true, `model.profile 未报 changed：${JSON.stringify(profile)}`)
    const profileMeta = profile.models?.['e2e-model-a']
    assert.ok(profileMeta !== undefined, `model.profile 缺模型档案：${JSON.stringify(profile)}`)
    assert.equal(profileMeta.context_window, 128000, JSON.stringify(profileMeta))
    assert.equal(profileMeta.max_output, 8192, JSON.stringify(profileMeta))
    assert.ok(Array.isArray(profileMeta.reasoning), JSON.stringify(profileMeta))
    assert.ok(profileMeta.modalities !== undefined, JSON.stringify(profileMeta))
    console.log('model.profile：ok（changed=true；context_window/max_output/reasoning/modalities 已装配）')

    // model.discover：先写密钥 + model.probe 槽，调用后断言结果形状与清槽。
    const modelSecret = await httpCall(port, 'POST', '/api/secrets/put', { name: 'E2E_MODEL_KEY', value: 'dummy' })
    assert.equal(modelSecret.status, 200, modelSecret.body)
    const probePos = boot(root, ['status'], env).world_head.hash
    const probeWritten = boot(root, ['run', JSON.stringify([
      {
        kind: 'write',
        request: {
          id: 'e2e-model-probe',
          op: 'batch',
          target: { expect_pos: probePos },
          args: writeSlotBody('_main', {
            kind: 'model.probe',
            url: fakeBase,
            auth_ref: { kind: 'local', name: 'E2E_MODEL_KEY' },
          }),
          by: 'e2e',
        },
      },
    ])], env)
    assert.equal(probeWritten.status, 'done', `写探测槽未完成：${JSON.stringify(probeWritten)}`)
    const discover = extractValue(boot(root, ['model.discover'], env))
    assert.equal(discover.ok, true, `model.discover 非成功结果：${JSON.stringify(discover)}`)
    assert.deepEqual(discover.models, ['e2e-model-a', 'e2e-model-b'], `model.discover 结果形状不符：${JSON.stringify(discover)}`)
    const inputAfter = extractValue(boot(root, ['input.read'], env))
    assert.equal(inputAfter.slots?._main?.kind, 'idle', `model.probe 槽未清：${JSON.stringify(inputAfter)}`)
    console.log('model.discover：ok（命中 2 个模型；model.probe 槽已清为 idle）')

    const healthResult = extractValue(boot(root, ['orchestration.health'], env))
    assert.equal(healthResult.ok, true, `orchestration.health 非成功结果：${JSON.stringify(healthResult)}`)
    assert.equal(healthResult.status, 'ok', JSON.stringify(healthResult))
    assert.equal(healthResult.consecutive_refused, 0, JSON.stringify(healthResult))
    assert.equal(healthResult.threshold_source, 'default', JSON.stringify(healthResult))
    assert.deepEqual(healthResult.refusal_codes, [], JSON.stringify(healthResult))
    assert.equal(healthResult.rollback, null, JSON.stringify(healthResult))
    assert.ok(healthResult.ledger !== undefined, `orchestration.health 缺台账：${JSON.stringify(healthResult)}`)
    console.log(`orchestration.health：ok（status=ok，threshold_source=default，台账三链：${Object.keys(healthResult.ledger).join('/')}）`)

    // 8) 未就位依赖降级：编排图身份未入世 → 命令 refused、不崩
    const graph = await httpCall(port, 'POST', '/api/command', { name: 'orchestration.graph', args: null })
    assert.equal(graph.status, 200, graph.body)
    const graphBody = JSON.parse(graph.body)
    assert.equal(graphBody.value, null, graph.body)
    assert.equal(graphBody.status, 'refused', graph.body)
    const afterGraph = await httpCall(port, 'GET', '/api/state')
    assert.equal(afterGraph.status, 200)
    console.log('未就位依赖：ok（orchestration.graph refused，进程未崩）')

    // 9) 技能直写（客户端身份经入站面 submit）→ 只读命令读回
    const skillBody = {
      version: 1,
      skills: [
        {
          id: 'e2e-skill',
          name: 'E2E',
          description: 'smoke',
          triggers: { keywords: ['e2e'], file_globs: [], explicit: [] },
          scope: { kind: 'global' },
          body: 'demo',
          enabled: true,
          at: new Date().toISOString(),
        },
      ],
    }
    const skillSubmit = await httpCall(port, 'POST', '/api/submit', {
      directives: [
        {
          kind: 'write',
          request: {
            op: 'batch',
            args: {
              ops: [
                { op: 'put', args: { body: skillBody } },
                { op: 'add_gen', args: { id: 'skill', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
              ],
            },
          },
        },
      ],
      thread: '_main',
    })
    assert.equal(skillSubmit.status, 202, skillSubmit.body)
    await waitFor(() => {
      const result = spawnSync(
        process.execPath,
        [BOOT_MAIN, 'settings.skills', '--root', root],
        { encoding: 'utf8', cwd: REPO_ROOT, env },
      )
      if (result.status !== 0) return false
      try {
        const parsed = JSON.parse(result.stdout.trim())
        const value = parsed.observations?.[0]?.value
        return Boolean(value && value.body && Array.isArray(value.body.skills) && value.body.skills.some((item) => item.id === 'e2e-skill'))
      } catch {
        return false
      }
    }, 'skill written and readable')
    console.log('技能直写：ok（submit 落账后 settings.skills 读回）')

    // 10) 密钥直写（不进世界）：put → 只读命令读到 has → delete
    const secretName = 'E2E_LOCAL_SECRET'
    const put = await httpCall(port, 'POST', '/api/secrets/put', { name: secretName, value: 'not-a-real-key' })
    assert.equal(put.status, 200, put.body)
    const secrets = await httpCall(port, 'POST', '/api/command', { name: 'secrets.status', args: null })
    assert.equal(secrets.status, 200, secrets.body)
    const secretList = JSON.parse(secrets.body).value
    assert.ok(Array.isArray(secretList) && secretList.some((item) => item.name === secretName && item.has === true), secrets.body)
    const del = await httpCall(port, 'POST', '/api/secrets/delete', { name: secretName })
    assert.equal(del.status, 200, del.body)
    console.log('密钥直写：ok（put → secrets.status 读到 → delete）')

    // 11) SSE：本插件连接态事件
    const sse = openSse(port, (record) => record.impl === 'ui-settings' && record.topic === 'settings.state')
    await sse.ready
    const sseResult = await sse.result
    assert.equal(sseResult.found.impl, 'ui-settings')
    console.log(`SSE：ok（收到 ${sseResult.found.topic}）`)

    // 12) 真实模型集成（可选）：读仓库根 .env 的 base_url / model_id；缺失或失败优雅跳过。
    const dotenv = readDotEnv()
    if (dotenv.base_url && dotenv.model_id) {
      try {
        const expectPos = boot(root, ['status'], env).world_head.hash
        const probeDirective = [
          {
            kind: 'write',
            request: {
              id: 'e2e-model-probe-real',
              op: 'batch',
              target: { expect_pos: expectPos },
              args: writeSlotBody('_main', {
                kind: 'model.probe',
                url: dotenv.base_url,
                auth_ref: { kind: 'local', name: 'E2E_MODEL_KEY' },
              }),
              by: 'e2e',
            },
          },
        ]
        const probeWritten = boot(root, ['run', JSON.stringify(probeDirective)], env)
        assert.equal(probeWritten.status, 'done', `写探测槽未完成：${JSON.stringify(probeWritten)}`)
        const value = extractValue(boot(root, ['model.discover'], env))
        if (value && value.ok === true && Array.isArray(value.models) && value.models.includes(dotenv.model_id)) {
          console.log(`真实模型集成：ok（discover 命中 ${dotenv.model_id}，共 ${value.models.length} 个模型）`)
        } else {
          console.log(`真实模型集成：跳过（discover 未命中 ${dotenv.model_id}：${JSON.stringify(value)}）`)
        }
      } catch (err) {
        console.log(`真实模型集成：跳过（${err.message}）`)
      }
    } else {
      console.log('真实模型集成：跳过（.env 缺 base_url / model_id）')
    }

    // 13) stop → verify + replay
    const beforeStop = boot(root, ['status'], env)
    boot(root, ['stop'], env)
    started = false
    const verified = boot(root, ['verify'], env)
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    const replayed = boot(root, ['replay'], env)
    assert.deepEqual(replayed.head, beforeStop.world_head, 'replay 链头与 status 不一致')
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
    await new Promise((resolveClose) => {
      fakeModel.once('exit', resolveClose)
      fakeModel.kill()
    })
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(root, { recursive: true, force: true })
        break
      } catch (err) {
        if (attempt === 4) console.error(`清理临时 root 失败（不影响结果）：${err.message}`)
        else await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
      }
    }
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
