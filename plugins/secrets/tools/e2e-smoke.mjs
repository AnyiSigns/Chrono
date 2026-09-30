// `secrets` 入世冒烟（黑盒，经 boot CLI + 直连服务协议）：
// pack secrets → seed → start（宿主起服务并握手）→ 直连 secrets 服务调 resolve / list
// → stop。宿主是单写者，任何失败路径都会尝试 stop 释放锁。
// 用法：node plugins/secrets/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const SECRETS_DIR = join(REPO_ROOT, 'plugins', 'secrets')
const SECRETS_LOCAL_DIR = join(REPO_ROOT, 'plugins', 'secrets-local')

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

/** 测试用本地文件读取（仿真 secrets-local）：缺失 → 空表；损坏 → 不可读。 */
function readLocalSecrets(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, secrets: {} }
    return { ok: false }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false }
  const secrets = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') secrets[name] = value
  }
  return { ok: true, secrets }
}

/** 仿真 secrets-env 后端取值（门面不读 env 值；由本进程按名应答）。 */
const ENV_VALUES = { E2E_ENV_KEY: 'sk-e2e-env' }

/** 仿真宿主侧路由：把 secrets 的反向 `port.call secrets-backend.*` 应答为内置后端
 *  secrets-local / secrets-env 的 kinds / read / list（门面按 `kinds` 定位 kind 的后端）。 */
function answerPortCall(message, secretsFile) {
  const base = { v: '1', id: message.id }
  if (message.port !== 'secrets-backend') {
    return { ...base, kind: 'port.error', ok: false, error: 'unresolved_cap', message: `no route for ${message.port}` }
  }
  if (message.provider === 'secrets-env') {
    if (message.method === 'kinds') return { ...base, kind: 'port.result', ok: true, value: ['env'] }
    if (message.method === 'list') return { ...base, kind: 'port.result', ok: true, value: [] }
    if (message.method === 'read') {
      const value = ENV_VALUES[message.args?.name]
      if (value === undefined) {
        return { ...base, kind: 'port.error', ok: false, error: 'secret_missing', message: 'missing' }
      }
      return { ...base, kind: 'port.result', ok: true, value }
    }
    return { ...base, kind: 'port.error', ok: false, error: 'unknown_method', message: message.method }
  }
  if (message.provider !== 'secrets-local') {
    return { ...base, kind: 'port.error', ok: false, error: 'unresolved_cap', message: `no route for ${message.port}` }
  }
  if (message.method === 'kinds') {
    return { ...base, kind: 'port.result', ok: true, value: ['local'] }
  }
  const read = readLocalSecrets(secretsFile)
  if (!read.ok) {
    return { ...base, kind: 'port.error', ok: false, error: 'secret_unreadable', message: 'unreadable' }
  }
  if (message.method === 'list') {
    const value = Object.keys(read.secrets)
      .sort()
      .map((name) => ({ name, has: true }))
    return { ...base, kind: 'port.result', ok: true, value }
  }
  if (message.method === 'read') {
    const value = read.secrets[message.args?.name]
    if (value === undefined) {
      return { ...base, kind: 'port.error', ok: false, error: 'secret_missing', message: 'missing' }
    }
    return { ...base, kind: 'port.result', ok: true, value }
  }
  return { ...base, kind: 'port.error', ok: false, error: 'unknown_method', message: message.method }
}

/** 直连 secrets 服务：hello → call，返回 result / error 帧；反向 `port.call` 由本进程桥接。 */
function callService(pluginState, method, args, extraEnv = {}) {
  const secretsFile = resolve(pluginState, '..', '..', 'secrets.local.json')
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, ['execute/main.ts'], {
      cwd: SECRETS_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CHRONO_PLUGIN_STATE: pluginState,
        CHRONO_PLUGIN_MANY_NEEDS: JSON.stringify({ 'secrets-backend': ['secrets-env', 'secrets-local'] }),
        ...extraEnv,
      },
    })
    const decoder = createDecoder()
    const pending = new Map()
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error('secrets 服务调用超时'))
    }, 8000)
    child.stdout.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
        if (message.kind === 'port.call') {
          child.stdin.write(encodeFrame(answerPortCall(message, secretsFile)))
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
      const expected = Array.isArray(expect) ? expect : [expect]
      return new Promise((resolveRequest, rejectRequest) => {
        pending.set(id, (message) => {
          if (!expected.includes(message.kind)) {
            rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
            return
          }
          resolveRequest(message)
        })
        child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
      })
    }
    ;(async () => {
      await request('hello', { impl: 'secrets', gen: 'e2e' }, 'manifest')
      const message = await request(
        'call',
        {
          port: 'secrets',
          method,
          args,
          env: { run: 'e2e-run', thread: null, now: 0 },
        },
        ['result', 'error'],
      )
      clearTimeout(timer)
      child.stdin.end()
      resolveCall(message)
    })().catch((err) => {
      clearTimeout(timer)
      child.kill()
      rejectCall(err)
    })
  })
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-secrets-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  // 服务入口裸 import 'plugin-sdk'：宿主在准备阶段把框架安装的 SDK 链接进物化树，
  // 故本冒烟无需在临时根下手建 node_modules/plugin-sdk。
  let started = false
  try {
    const packedLocal = boot(root, ['pack', SECRETS_LOCAL_DIR, '--identity', 'secrets-local'])
    assert.equal(packedLocal.ok, true, 'pack secrets-local 报告 ok:false')
    const packed = boot(root, ['pack', SECRETS_DIR, '--identity', 'secrets'])
    assert.equal(packed.ok, true, 'pack secrets 报告 ok:false')
    console.log(`pack secrets-local / secrets: ${packedLocal.status} / ${packed.status}`)

    // 提供方（secrets-local）在前：seed 按清单顺序处理，needs 解析依赖提供方已 active。
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([
        { name: 'secrets-local', path: SECRETS_LOCAL_DIR },
        { name: 'secrets', path: SECRETS_DIR },
      ]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    const status = boot(root, ['status'])
    assert.ok(
      status.loaded.some((item) => item.id === 'secrets-local'),
      `secrets-local 未装载：${JSON.stringify(status.loaded)}`,
    )
    assert.ok(
      status.loaded.some((item) => item.id === 'secrets'),
      `secrets 未装载：${JSON.stringify(status.loaded)}`,
    )
    console.log('start + 握手：ok')

    const secretsFile = join(root, 'state', 'secrets.local.json')
    writeFileSync(secretsFile, JSON.stringify({ E2E_LOCAL_KEY: 'sk-e2e-local' }))
    const pluginState = join(root, 'state', 'plugins', 'secrets')

    const local = await callService(pluginState, 'resolve', { auth_ref: { kind: 'local', name: 'E2E_LOCAL_KEY' } })
    assert.equal(local.kind, 'result')
    assert.equal(local.value, 'sk-e2e-local')
    console.log('resolve local：ok')

    const envResolved = await callService(
      pluginState,
      'resolve',
      { auth_ref: { kind: 'env', name: 'E2E_ENV_KEY' } },
      { E2E_ENV_KEY: 'sk-e2e-env' },
    )
    assert.equal(envResolved.value, 'sk-e2e-env')
    console.log('resolve env：ok')

    const listed = await callService(pluginState, 'list', {})
    assert.deepEqual(listed.value, [{ name: 'E2E_LOCAL_KEY', has: true }])
    console.log('list：ok')

    boot(root, ['stop'])
    started = false
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
