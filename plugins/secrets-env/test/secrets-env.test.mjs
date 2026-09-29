// `secrets-env` 服务协议级测试（node --test）：自实现最小协议驱动。
// 驱动 spawn `node execute/main.ts`（按宿主机制注入进程环境变量），
// 发 hello → 收 manifest，发 call → 收 result / error，覆盖 reload / drain / probe 与 stdin EOF 自退出。
// 重点：secrets-backend 提供方（read / list / kinds）、从本服务进程环境取值、明文不进 stderr。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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

function startService({ extraEnv = {} } = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: PKG_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
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
      return request('hello', { impl: 'secrets-env', gen: 'gen-1' }, 'manifest')
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
  const drv = startService()
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'secrets-env')
    assert.deepEqual(manifest.implements, ['secrets-backend'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.deepEqual(manifest.methods['secrets-backend'], ['read', 'list', 'kinds'])
  } finally {
    drv.close()
  }
})

test('reload → ack / drain → bye / probe → pong', async () => {
  const drv = startService()
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
  const drv = startService()
  await drv.hello()
  drv.close()
  assert.equal(await drv.exit, 0)
})

// ── kinds ──────────────────────────────────────────────────────────────────

test('kinds：自述支持 auth_ref.kind = env', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const message = await drv.call('kinds', {})
    assert.equal(message.kind, 'result')
    assert.deepEqual(message.value, ['env'])
  } finally {
    drv.close()
  }
})

// ── read ───────────────────────────────────────────────────────────────────

test('read：读本服务进程环境的明文', async () => {
  const drv = startService({ extraEnv: { MY_ENV_SECRET: 'env-abc' } })
  try {
    await drv.hello()
    const message = await drv.call('read', { name: 'MY_ENV_SECRET' })
    assert.equal(message.kind, 'result')
    assert.equal(message.value, 'env-abc')
  } finally {
    drv.close()
  }
})

test('read 缺失：引用名不存在 → secret_missing', async () => {
  const drv = startService()
  try {
    await drv.hello()
    const message = await drv.call('read', { name: 'ABSENT_ENV_SECRET' })
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_missing')
  } finally {
    drv.close()
  }
})

test('read bad_args：缺 name / 非字符串 / 含 NUL', async () => {
  const drv = startService({ extraEnv: { K: 'v' } })
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

test('list 恒回空表（进程环境不枚举，避免泄漏变量名）', async () => {
  const drv = startService({ extraEnv: { SECRET_A: 'a', SECRET_B: 'b' } })
  try {
    await drv.hello()
    const message = await drv.call('list', {})
    assert.equal(message.kind, 'result')
    assert.deepEqual(message.value, [])
  } finally {
    drv.close()
  }
})

// ── 义务 / 健壮性 ───────────────────────────────────────────────────────────

test('明文不进 stderr：read 成功与失败后 stderr 都不含值', async () => {
  const drv = startService({ extraEnv: { TOP_SECRET: 'super-secret-plaintext' } })
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
  const drv = startService({ extraEnv: { K: 'v' } })
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
