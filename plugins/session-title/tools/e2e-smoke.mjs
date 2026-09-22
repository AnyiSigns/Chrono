// `session-title` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack 依赖链（secrets → model-protocol → session → session-title）→ seed
// → 离线读投影确认四身份在册（pins 解析通过）→ 声明门禁负例 → 直连服务协议，把反向调用桥接到内存假后端
// → 覆盖 generate 的正常生成、写计划原样上提与非流式。
// 说明：**不执行 `boot start`**——本次验收只到「声明与协议就位」；pack / seed 已覆盖插件声明、pins 与 .worldignore 的宿主门禁。
// 用法：node plugins/session-title/tools/e2e-smoke.mjs
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
const PLUGIN_DIRS = [
  ['secrets', join(REPO_ROOT, 'plugins', 'secrets')],
  ['model-protocol', join(REPO_ROOT, 'plugins', 'model-protocol')],
  ['session', join(REPO_ROOT, 'plugins', 'session')],
  ['session-title', join(REPO_ROOT, 'plugins', 'session-title')],
]

function bootRaw(root, args) {
  return spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
  })
}

function boot(root, args) {
  const result = bootRaw(root, args)
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
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

/** 极简协议客户端：按 4 字节大端长度前缀切帧。 */
function frameReader(child) {
  let buffer = Buffer.alloc(0)
  const queued = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (buffer.length < 4 + length) break
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      const message = JSON.parse(body.toString('utf8'))
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(message)
      else queued.push(message)
    }
  })
  return () =>
    new Promise((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error('等待协议帧超时')), 30000)
      const done = (message) => {
        clearTimeout(timer)
        resolveFrame(message)
      }
      if (queued.length > 0) done(queued.shift())
      else waiters.push(done)
    })
}

function waitExit(child) {
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.kill()
      resolveExit()
    }, 10000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

/**
 * 直连 session-title 服务 stdio，把 `port.call` 桥接到内存假后端：
 * `model.complete` 回确定性标题；`session.set_title` 回写计划。
 */
async function directProtocolSmoke(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const next = frameReader(child)
  const portCalls = []
  const events = []
  const env = { run: 'e2e', thread: null, now: 1_700_000_000_000 }
  const plan = {
    $directives: [
      {
        kind: 'write',
        request: {
          op: 'batch',
          args: {
            ops: [
              { op: 'put', args: { body: { current: 'c-1', conversations: [{ id: 'c-1', title: '快速排序算法' }] } } },
              { op: 'add_gen', args: { id: 'session', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
            ],
          },
        },
      },
      { kind: 'extern', payload: { ok: true, conversation: 'c-1', title: '快速排序算法' } },
    ],
  }

  function bridge(message) {
    portCalls.push(message)
    if (message.port === 'model' && message.method === 'complete') {
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true, text: '"快速排序算法。"' } }))
      return
    }
    if (message.port === 'session' && message.method === 'set_title') {
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: plan }))
      return
    }
    child.stdin.write(
      encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'not_ready', message: 'e2e' }),
    )
  }

  async function call(id, method, args) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'session-title', method, args, env }))
    for (;;) {
      const message = await next()
      if (message.kind === 'event') {
        events.push(message)
        continue
      }
      if (message.kind === 'port.call') {
        bridge(message)
        continue
      }
      if ((message.kind === 'result' || message.kind === 'error') && message.id === id) return message
    }
  }

  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'session-title' }))
    const manifest = await next()
    assert.equal(manifest.kind, 'manifest', 'session-title hello 应回 manifest')
    assert.equal(manifest.identity, 'session-title')
    assert.deepEqual(manifest.methods['session-title'], ['generate'])

    const result = await call('g1', 'generate', {
      conversation: 'c-1',
      first_message: '帮我写一个快速排序',
      vendor: 'vendor-openai',
      model: 'gpt-4o-mini',
      params: { temperature: 0.3 },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.deepEqual(directivesOf(result.value), plan.$directives, 'generate 应原样上提会话写计划')
    const model = portCalls.find((frame) => frame.port === 'model')
    assert.equal(model.method, 'complete', '应走非流式 complete')
    const setTitle = portCalls.find((frame) => frame.port === 'session' && frame.method === 'set_title')
    assert.equal(setTitle.args.title, '快速排序算法', '引号与结尾标点应被清理')
    assert.equal(events.length, 0, '非流式：不发 model.delta 事件')

    console.log('直连协议：generate 正常生成 + 写计划原样上提 + 非流式')
  } finally {
    child.stdin.end()
    await waitExit(child)
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-session-title-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  try {
    for (const [identity, dir] of PLUGIN_DIRS) {
      const packed = boot(root, ['pack', dir, '--identity', identity])
      assert.equal(packed.ok, true, `pack ${identity} 报告 ok:false`)
      console.log(`pack ${identity}: ${packed.status}`)
    }

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(PLUGIN_DIRS.map(([name, path]) => ({ name, path }))),
    )

    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    assert.equal(seeded.items.length, PLUGIN_DIRS.length, 'seed 应覆盖全部四身份')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    for (const [identity] of PLUGIN_DIRS) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    assert.deepEqual(
      projection.ids['session-title'].pins,
      { model: 'model-protocol', session: 'session' },
      'session-title pins 应解析为身份名',
    )
    console.log('离线投影：四身份在册，session-title pins 解析通过')

    const gate = bootRaw(root, ['pack', join(REPO_ROOT, 'plugins', 'session-title'), '--identity', 'wrong-identity'])
    assert.notEqual(gate.status, 0, '身份不一致应被声明门禁拒绝')
    console.log('声明门禁：identity_mismatch 负例被拒')

    await directProtocolSmoke(join(REPO_ROOT, 'plugins', 'session-title', 'execute', 'main.ts'))

    const verified = boot(root, ['verify'])
    assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
    console.log('verify：ok')

    console.log(`E2E ok（root=${root}）`)
  } finally {
    // 未 start，无需 stop；pack / seed 已释放写者锁。
  }
}

main().catch((err) => {
  console.error(err.stack || err.message)
  process.exitCode = 1
})
