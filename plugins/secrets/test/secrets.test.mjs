// `secrets` 服务协议级测试（node --test）：经 bridge 驱动真实门面进程，
// 反向 `port.call` 由 driver 按 provider 转给假后端（local / env）。
// 重点：local / env 经成员后端解析、结构化失败、list 汇总只回 {name,has}、明文不进 stderr、
// kind 定位（未声明 kind 报 unsupported）、auth_ref 形态校验。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { encodeFrame } from 'plugin-sdk'
import { PKG_ROOT, startFacade } from './driver.mjs'

/** 临时宿主根：`<root>/state/plugins/secrets` 已建（模拟宿主注入的 ③ 目录）。 */
function makeRoot() {
  mkdirSync(join(tmpdir(), 'kilo'), { recursive: true })
  const root = mkdtempSync(join(tmpdir(), 'kilo', 'secrets-test-'))
  const pluginState = join(root, 'state', 'plugins', 'secrets')
  mkdirSync(pluginState, { recursive: true })
  return { root, pluginState, secretsFile: join(root, 'state', 'secrets.local.json') }
}

function writeSecrets(file, value) {
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

/** 一个受限的协议驱动：只做 hello + 调用，供「缺声明回落」用例注入无 methods 的临时包。 */
function startRaw(entry, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, [entry], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  })
  const pending = []
  let buffered = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    const messages = []
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0)
      if (buffered.length < 4 + length) break
      const body = buffered.subarray(4, 4 + length).toString('utf8')
      buffered = buffered.subarray(4 + length)
      messages.push(JSON.parse(body))
    }
    for (const message of messages) for (const handler of [...pending]) handler(message)
  })
  child.once('exit', (code) => {
    for (const handler of pending) handler({ kind: 'exit', code })
  })
  const reply = (id) =>
    new Promise((resolveReply, rejectReply) => {
      const timer = setTimeout(() => rejectReply(new Error(`timeout waiting ${id}`)), 5000)
      pending.push((message) => {
        if (message.id !== id) return
        clearTimeout(timer)
        resolveReply(message)
      })
    })
  return { child, reply }
}

// ── 握手 / 控制 ────────────────────────────────────────────────────────────

test('缺 methods 声明回落处理器表（无 TDZ）', async () => {
  // 临时包落在包根（非 test/ 下）：裸 import 'plugin-sdk' 沿父目录解析到仓库根 node_modules，
  // 且不被 node --test 的 `test/**` 发现规则当作测试文件执行。
  const dir = mkdtempSync(join(PKG_ROOT, '.tmp-nomethods-'))
  cpSync(join(PKG_ROOT, 'execute'), join(dir, 'execute'), { recursive: true })
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      identity: 'secrets',
      implements: ['secrets'],
      pins: {},
      start: '',
      protocol: '1',
      state: 'recomputable',
    }),
  )
  const { pluginState } = makeRoot()
  const { child, reply } = startRaw(join(dir, 'execute', 'main.ts'), dir, {
    CHRONO_PLUGIN_STATE: pluginState,
  })
  try {
    const manifestReply = reply('drv-1')
    child.stdin.write(
      encodeFrame({ v: '1', id: 'drv-1', kind: 'hello', impl: 'secrets', gen: 'g' }),
    )
    const manifest = await manifestReply
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.identity, 'secrets')
    // 缺声明时回落 HANDLERS 键：resolve 仍被识别（不是 unknown_method）+ auth_ref 形态校验
    const resolveReply = reply('drv-2')
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: 'drv-2',
        kind: 'call',
        port: 'secrets',
        method: 'resolve',
        args: { auth_ref: {} },
        env: { run: null, thread: null, now: 0 },
      }),
    )
    const resolved = await resolveReply
    assert.equal(resolved.kind, 'error')
    assert.equal(resolved.code, 'bad_auth_ref')
  } finally {
    child.stdin.end()
    if (child.exitCode === null) {
      await new Promise((resolveExit) => child.once('exit', resolveExit))
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hello 回 manifest，声明与 plugin.json 一致（消费方面零改动）', async () => {
  const { pluginState } = makeRoot()
  const drv = startFacade({ secretsFile: join(pluginState, '..', '..', 'secrets.local.json') })
  try {
    const manifest = await drv.hello()
    assert.equal(manifest.v, '1')
    assert.equal(manifest.identity, 'secrets')
    assert.deepEqual(manifest.implements, ['secrets'])
    assert.equal(manifest.protocol, '1')
    assert.equal(manifest.state, 'recomputable')
    assert.deepEqual(manifest.methods.secrets, ['resolve', 'list'])
  } finally {
    drv.close()
  }
})

test('reload → ack / drain → bye / probe → pong', async () => {
  const { pluginState } = makeRoot()
  const drv = startFacade({ secretsFile: join(pluginState, '..', '..', 'secrets.local.json') })
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
  const drv = startFacade({ secretsFile: join(pluginState, '..', '..', 'secrets.local.json') })
  await drv.hello()
  drv.close()
  assert.equal(await drv.exit, 0)
})

// ── resolve ────────────────────────────────────────────────────────────────

test('resolve local：经 local 后端读宿主 state/secrets.local.json 的明文', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { DEEPSEEK_API_KEY: 'sk-local-123' })
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const message = await drv.call('resolve', {
      auth_ref: { kind: 'local', name: 'DEEPSEEK_API_KEY' },
    })
    assert.equal(message.kind, 'result')
    assert.equal(message.value, 'sk-local-123')
  } finally {
    drv.close()
  }
})

test('resolve local：kind 缺省即 local', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { K: 'v' })
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const message = await drv.call('resolve', { auth_ref: { name: 'K' } })
    assert.equal(message.kind, 'result')
    assert.equal(message.value, 'v')
  } finally {
    drv.close()
  }
})

test('resolve env：经 env 后端取值', async () => {
  const { secretsFile } = makeRoot()
  const drv = startFacade({ secretsFile, env: { MY_ENV_SECRET: 'env-abc' } })
  try {
    await drv.hello()
    const message = await drv.call('resolve', { auth_ref: { kind: 'env', name: 'MY_ENV_SECRET' } })
    assert.equal(message.kind, 'result')
    assert.equal(message.value, 'env-abc')
  } finally {
    drv.close()
  }
})

test('resolve 缺失：local / env 都回 secret_missing', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { PRESENT: 'x' })
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const local = await drv.call('resolve', { auth_ref: { kind: 'local', name: 'ABSENT' } })
    assert.equal(local.kind, 'error')
    assert.equal(local.code, 'secret_missing')
    const env = await drv.call('resolve', { auth_ref: { kind: 'env', name: 'ABSENT_ENV' } })
    assert.equal(env.kind, 'error')
    assert.equal(env.code, 'secret_missing')
  } finally {
    drv.close()
  }
})

test('resolve unreadable：本地文件 JSON 损坏 → secret_unreadable，不泄漏文件内容', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, '{ not-json-secret-body')
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const message = await drv.call('resolve', { auth_ref: { kind: 'local', name: 'ANY' } })
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_unreadable')
    assert.ok(!JSON.stringify(message).includes('not-json-secret-body'))
    assert.ok(!drv.stderrText().includes('not-json-secret-body'))
  } finally {
    drv.close()
  }
})

test('resolve kind 未声明 → secret_kind_unsupported（kind 词表开放）', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { K: 'v' })
  const drv = startFacade({ secretsFile, members: ['secrets-env', 'secrets-local'] })
  try {
    await drv.hello()
    const message = await drv.call('resolve', { auth_ref: { kind: 'vault', name: 'K' } })
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_kind_unsupported')
  } finally {
    drv.close()
  }
})

test('resolve bad_auth_ref：kind 空 / 非字符串；缺 name / 非对象 / 原型键', async () => {
  const { secretsFile } = makeRoot()
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    for (const auth_ref of [
      { kind: '', name: 'K' },
      { kind: 7, name: 'K' },
      { kind: 'local' },
      'K',
      { kind: 'local', name: '__proto__' },
    ]) {
      const message = await drv.call('resolve', { auth_ref })
      assert.equal(message.kind, 'error', JSON.stringify(auth_ref))
      assert.equal(message.code, 'bad_auth_ref', JSON.stringify(auth_ref))
    }
  } finally {
    drv.close()
  }
})

// ── list ───────────────────────────────────────────────────────────────────

test('list 汇总各后端只回 {name,has}（不回值），名字排序；缺文件回 []', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { ZED: 'z-value', ALPHA: 'a-value' })
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const message = await drv.call('list', {})
    assert.equal(message.kind, 'result')
    assert.deepEqual(message.value, [
      { name: 'ALPHA', has: true },
      { name: 'ZED', has: true },
    ])
    // 契约：缺名 = 未读到；has 恒 true，has:false 不可达；env 后端不贡献清单项
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
  const drv2 = startFacade({ secretsFile: empty.secretsFile })
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
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, 'oops')
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const message = await drv.call('list', {})
    assert.equal(message.kind, 'error')
    assert.equal(message.code, 'secret_unreadable')
  } finally {
    drv.close()
  }
})

// ── 义务 / 健壮性 ───────────────────────────────────────────────────────────

test('明文不进 stderr：resolve 成功与失败后 stderr 都不含值', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { TOP_SECRET: 'super-secret-plaintext' })
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const ok = await drv.call('resolve', { auth_ref: { kind: 'local', name: 'TOP_SECRET' } })
    assert.equal(ok.value, 'super-secret-plaintext')
    const missing = await drv.call('resolve', { auth_ref: { kind: 'local', name: 'NOPE' } })
    assert.equal(missing.code, 'secret_missing')
    assert.ok(!drv.stderrText().includes('super-secret-plaintext'))
  } finally {
    drv.close()
  }
})

test('结构化错误不崩进程：错误后仍可正常服务', async () => {
  const { secretsFile } = makeRoot()
  writeSecrets(secretsFile, { K: 'v' })
  const drv = startFacade({ secretsFile })
  try {
    await drv.hello()
    const bad = await drv.call('resolve', { auth_ref: { kind: 'vault', name: 'K' } })
    assert.equal(bad.code, 'secret_kind_unsupported')
    const unknown = await drv.call('nope', {})
    assert.equal(unknown.kind, 'error')
    const nonObject = await drv.call('resolve', 'x')
    assert.equal(nonObject.kind, 'error')
    const ok = await drv.call('resolve', { auth_ref: { kind: 'local', name: 'K' } })
    assert.equal(ok.kind, 'result')
    assert.equal(ok.value, 'v')
  } finally {
    drv.close()
  }
})
