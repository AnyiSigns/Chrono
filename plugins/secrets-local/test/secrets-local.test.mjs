// `secrets-local` 服务协议级测试（node --test）：自实现最小协议驱动。
// 驱动 spawn `node execute/main.ts`（按宿主机制注入 CHRONO_PLUGIN_STATE），
// 发 hello → 收 manifest，发 call → 收 result / error，覆盖 reload / drain / probe 与 stdin EOF 自退出。
// 重点：secrets-backend 提供方（read / list / kinds）、路径解析、结构化失败、明文不进 stderr。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const CAP = 'secrets-backend'

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

/** 临时宿主根：`<root>/state/plugins/secrets-local` 已建（模拟宿主注入的 ③ 目录）。 */
function makeRoot() {
  mkdirSync(join(tmpdir(), 'kilo'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'kilo', 'secrets-local-test-'))
  const pluginState = join(root, 'state', 'plugins', 'secrets-local')
  mkdirSync(pluginState, { recursive: true })
  return {
    root,
    pluginState,
    secretsFile: join(root, 'state', 'secrets.local.json'),
  }
}

function writeSecrets(file, value) {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

function startService({ pluginState, extraEnv = {} }) {
  const env = { ...process.env, CHRONO_PLUGIN_STATE: pluginState, ...extraEnv }
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  const decoder = createDecoder()
  const pending = new Map()
  let stderr = ''
  const exit = new Promise((resolveExit) => child.once('exit', (code) => resolveExit(code)))
  child.stdout.on('data', (chunk) => {
    for (const message of decoder.push(chunk)) {
      const handler = pending.get(message.id)
      if (handler !== undefined) {
        pending.delete(message.id)
        handler(message)
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  let seq = 0
  function request(kind, fields, expect) {
    seq += 1
    const id = `drv-${seq}`
    const expected = Array.isArray(expect) ? expect : [expect]
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectRequest(new Error(`timeout waiting ${expected.join('/')} for ${kind}`))
      }, 5000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (!expected.includes(message.kind)) {
          rejectRequest(new Error(`expected ${expected.join('/')} got ${message.kind}`))
          return
        }
        resolveRequest(message)
      })
      child.stdin.write(encodeFrame({ v: '1', id, kind, ...fields }))
    })
  }

  return {
    child,
    exit,
    stderrText: () => stderr,
    request,
    async hello() {
      return request('hello', { impl: 'secrets-local', gen: 'gen-1' }, 'manifest')
    },
    async call(method, args) {
      const message = await request(
        'call',
        {
          port: CAP,
          method,
          args,
          env: { run: null, thread: null, now: 0 },
        },
        ['result', 'error'],
      )
      return message
    },
    close() {
      child.stdin.end()
    },
  }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('hello 回 manifest，声明与 plugin.json 一致（secrets-backend 提供方）', async () => {
  const { pluginState } = makeRoot()
  const drv = startService({ pluginState })
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'secrets-local')
    assert.deepEqual(manifest.implements, ['secrets-backend'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    // 契约单源在拥有方 secrets 的 slots：提供方不在 manifest 复述 secrets-backend 方法。
    assert.equal(manifest.methods['secrets-backend'], undefined)
  } finally {
    drv.close()
  }
})

test('reload → ack / drain → bye / probe → pong', async () => {
  const { pluginState } = makeRoot()
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    assert.equal((await drv.request('reload', { gen: 'g2' }, 'ack')).kind, 'ack')
    assert.equal((await drv.request('probe', {}, 'pong')).ok, true)
    assert.equal((await drv.request('drain', { deadline_ms: 1000 }, 'bye')).kind, 'bye')
  } finally {
    drv.close()
  }
})

test('stdin EOF 即自退出（断连不占端点）', async () => {
  const { pluginState } = makeRoot()
  const drv = startService({ pluginState })
  await drv.hello()
  drv.close()
  assert.equal(await drv.exit, 0)
})

// ── kinds ──────────────────────────────────────────────────────────────────

test('kinds：自述支持 auth_ref.kind = local', async () => {
  const { pluginState } = makeRoot()
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const message = await drv.call('kinds', {})
    assert.equal(message.kind, 'result')
    assert.deepEqual(message.value, ['local'])
  } finally {
    drv.close()
  }
})

// ── read ───────────────────────────────────────────────────────────────────

test('read：读宿主 state/secrets.local.json 的明文', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, { DEEPSEEK_API_KEY: 'sk-local-123' })
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const message = await drv.call('read', { name: 'DEEPSEEK_API_KEY' })
    assert.equal(message.kind, 'result')
    assert.equal(message.value, 'sk-local-123')
  } finally {
    drv.close()
  }
})

test('read 缺失：引用名不存在 → secret_missing', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, { PRESENT: 'x' })
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const message = await drv.call('read', { name: 'ABSENT' })
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_missing')
  } finally {
    drv.close()
  }
})

test('read unreadable：本地文件 JSON 损坏 → secret_unreadable，不泄漏文件内容', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, '{ not-json-secret-body')
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const message = await drv.call('read', { name: 'ANY' })
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_unreadable')
    assert.ok(!JSON.stringify(message).includes('not-json-secret-body'))
    assert.ok(!drv.stderrText().includes('not-json-secret-body'))
  } finally {
    drv.close()
  }
})

test('read bad_args：缺 name / 非字符串 / 含 NUL', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, { K: 'v' })
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    for (const args of [{}, { name: 7 }, { name: 'a\u0000b' }]) {
      const message = await drv.call('read', args)
      assert.equal(message.kind, 'error')
      assert.equal(message.code, 'bad_args')
    }
  } finally {
    drv.close()
  }
})

// ── list ───────────────────────────────────────────────────────────────────

test('list 只回 {name,has}（不回值），名字排序；缺文件回 []', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, { ZED: 'z-value', ALPHA: 'a-value' })
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const message = await drv.call('list', {})
    assert.equal(message.kind, 'result')
    assert.deepEqual(message.value, [
      { name: 'ALPHA', has: true },
      { name: 'ZED', has: true },
    ])
    assert.equal(
      message.value.every((entry) => entry.has === true),
      true,
    )
    assert.ok(!JSON.stringify(message).includes('z-value'))
    assert.ok(!JSON.stringify(message).includes('a-value'))
  } finally {
    drv.close()
  }

  const empty = makeRoot()
  const drv2 = startService({ pluginState: empty.pluginState })
  try {
    await drv2.hello()
    const message = await drv2.call('list', null)
    assert.equal(message.kind, 'result')
    assert.deepEqual(message.value, [])
  } finally {
    drv2.close()
  }
})

test('list 遇损坏文件 → secret_unreadable（结构化，不崩）', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, 'oops')
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const message = await drv.call('list', {})
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_unreadable')
  } finally {
    drv.close()
  }
})

// ── 路径不可解析 / 义务 / 健壮性 ─────────────────────────────────────────────

test('未注入 CHRONO_PLUGIN_STATE：read / list 都回 secret_unreadable', async () => {
  const drv = startService({ pluginState: '' })
  try {
    await drv.hello()
    const read = await drv.call('read', { name: 'K' })
    assert.equal(read.kind, 'error')
    assert.equal(read.code, 'secret_unreadable')
    const list = await drv.call('list', {})
    assert.equal(list.kind, 'error')
    assert.equal(list.code, 'secret_unreadable')
  } finally {
    drv.close()
  }
})

test('明文不进 stderr：read 成功与失败后 stderr 都不含值', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, { TOP_SECRET: 'super-secret-plaintext' })
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const ok = await drv.call('read', { name: 'TOP_SECRET' })
    assert.equal(ok.value, 'super-secret-plaintext')
    const missing = await drv.call('read', { name: 'NOPE' })
    assert.equal(missing.code, 'secret_missing')
    assert.ok(!drv.stderrText().includes('super-secret-plaintext'))
  } finally {
    drv.close()
  }
})

test('结构化错误不崩进程：错误后仍可正常服务', async () => {
  const { pluginState, secretsFile } = makeRoot()
  writeSecrets(secretsFile, { K: 'v' })
  const drv = startService({ pluginState })
  try {
    await drv.hello()
    const bad = await drv.call('read', {})
    assert.equal(bad.code, 'bad_args')
    const unknown = await drv.call('nope', {})
    assert.equal(unknown.kind, 'error')
    const nonObject = await drv.call('read', 'x')
    assert.equal(nonObject.kind, 'error')
    const ok = await drv.call('read', { name: 'K' })
    assert.equal(ok.kind, 'result')
    assert.equal(ok.value, 'v')
  } finally {
    drv.close()
  }
})
