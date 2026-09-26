// `secrets` 入世冒烟（黑盒，经 boot CLI + 直连服务协议）：
// pack secrets → seed → start（宿主起服务并握手）→ 直连 secrets 服务调 resolve / list
// → stop。宿主是单写者，任何失败路径都会尝试 stop 释放锁。
// 用法：node plugins/secrets/tools/e2e-smoke.mjs
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const SECRETS_DIR = join(REPO_ROOT, 'plugins', 'secrets')

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

/** 直连 secrets 服务：hello → call，返回 result / error 帧。 */
function callService(pluginState, method, args, extraEnv = {}) {
  return new Promise((resolveCall, rejectCall) => {
    const child = spawn(process.execPath, ['execute/main.ts'], {
      cwd: SECRETS_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CHRONO_PLUGIN_STATE: pluginState, ...extraEnv },
    })
    const decoder = createDecoder()
    const pending = new Map()
    const timer = setTimeout(() => {
      child.kill()
      rejectCall(new Error('secrets 服务调用超时'))
    }, 8000)
    child.stdout.on('data', (chunk) => {
      for (const message of decoder.push(chunk)) {
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
  // 服务入口裸 import 'plugin-sdk'：宿主按根目录向上解析 node_modules。
  // 生产根目录 = 仓库（根 node_modules 有 SDK）；本冒烟用临时根，故在根下提供同一 SDK。
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  symlinkSync(
    join(REPO_ROOT, 'plugin-sdk'),
    join(root, 'node_modules', 'plugin-sdk'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  let started = false
  try {
    const packed = boot(root, ['pack', SECRETS_DIR, '--identity', 'secrets'])
    assert.equal(packed.ok, true, 'pack secrets 报告 ok:false')
    console.log(`pack secrets: ${packed.status}`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'secrets', path: SECRETS_DIR }]),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    boot(root, ['start'])
    started = true
    const status = boot(root, ['status'])
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
