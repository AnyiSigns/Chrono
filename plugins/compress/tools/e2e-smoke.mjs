// `compress` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack 依赖链（secrets → model-protocol → embedding → short-memory → compress）→ seed
// → 离线读投影确认五身份在册（pins 解析通过）→ 直连 compress 服务协议，把反向调用桥接到内存假后端
// → 覆盖 summarize / compact / extract / semantic 与写计划形状。
// 说明：**不执行 `boot start`**——embedding 是 Rust 服务，物化需 cargo build 与约百 MB 权重（宿主侧 ③），
// 与本次「声明与协议就位」验收无关，故跳过；pack / seed 已覆盖插件声明、pins 与 .worldignore 的宿主门禁。
// 用法：node plugins/compress/tools/e2e-smoke.mjs
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
  ['embedding', join(REPO_ROOT, 'plugins', 'embedding')],
  ['short-memory', join(REPO_ROOT, 'plugins', 'short-memory')],
  ['compress', join(REPO_ROOT, 'plugins', 'compress')],
]

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

function memoryFixture() {
  return {
    version: 1,
    sessions: {
      'c-keep': {
        summary: { goal: 'keep', decisions: [], facts: ['kept'], open_questions: [], files: [], next_steps: [] },
        covered_upto: 'msg-keep',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
    },
    workspaces: {},
  }
}

function directivesOf(value) {
  return Array.isArray(value?.$directives) ? value.$directives : []
}

function opsOf(value) {
  const batch = directivesOf(value).find((item) => item.kind === 'write')
  return Array.isArray(batch?.request?.args?.ops) ? batch.request.args.ops : []
}

function externOf(value) {
  const extern = directivesOf(value).find((item) => item.kind === 'extern')
  return extern?.payload ?? null
}

/**
 * 直连 compress 服务 stdio，把 `port.call` 桥接到内存假后端：
 * `embedding.embed` 回错误（去重回落文本）；`model.chat` 回确定性 JSON（semantic 路径）。
 */
async function directProtocolSmoke(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const next = frameReader(child)
  const portCalls = []
  const env = { run: 'e2e', thread: null, now: 1_700_000_000_000 }

  async function bridge(message) {
    portCalls.push(message)
    if (message.port === 'model' && message.method === 'chat') {
      const value = { ok: true, text: JSON.stringify({ goal: 'semantic-goal', facts: ['sf1', 'sf2'] }) }
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value }))
      return
    }
    child.stdin.write(
      encodeFrame({
        v: '1',
        id: message.id,
        kind: 'port.error',
        ok: false,
        error: 'embedding_unavailable',
        message: 'e2e skips embedding',
      }),
    )
  }

  async function call(id, method, args) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'compress', method, args, env }))
    for (;;) {
      const message = await next()
      if (message.kind === 'port.call') {
        await bridge(message)
        continue
      }
      if ((message.kind === 'result' || message.kind === 'error') && message.id === id) return message
    }
  }

  try {
    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'compress' }))
    const manifest = await next()
    assert.equal(manifest.kind, 'manifest', 'compress hello 应回 manifest')
    assert.equal(manifest.identity, 'compress')
    assert.deepEqual(manifest.methods.compress, ['summarize', 'compact', 'extract'])

    const memory = memoryFixture()
    const summarized = await call('s1', 'summarize', {
      memory,
      conversation: 'c-1',
      covered_upto: 'msg-9',
      goal: 'G',
      facts: ['f1', 'f2'],
    })
    assert.equal(summarized.kind, 'result', JSON.stringify(summarized))
    const summaryOps = opsOf(summarized.value)
    assert.deepEqual(summaryOps.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(summaryOps[1].args.id, 'short-memory')
    assert.equal(summaryOps[0].args.body.sessions['c-1'].summary.goal, 'G')
    assert.deepEqual(summaryOps[0].args.body.sessions['c-keep'], memory.sessions['c-keep'])
    assert.equal(externOf(summarized.value).dedup, 'text')

    const compacted = await call('s2', 'compact', {
      memory,
      conversation: 'c-1',
      workspace: 'w-1',
      goal: 'G',
      facts: ['one', 'two', 'three'],
      decisions: ['decide'],
    })
    const compactBody = opsOf(compacted.value)[0].args.body
    const items = compactBody.workspaces['w-1'].summary.facts
    assert.ok(items.length >= 2 && items.length <= 3, `compact items=${items.length}`)
    assert.equal(externOf(compacted.value).kind, 'compact')

    const semantic = await call('s3', 'summarize', {
      memory,
      conversation: 'c-1',
      mode: 'semantic',
      model_config: { base_url: 'https://example.invalid', model: 'm', quirks: { impl: 'protocol', protocol: 'openai-chat' } },
      session_slice: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(externOf(semantic.value).summary.goal, 'semantic-goal')
    assert.ok(portCalls.some((callFrame) => callFrame.port === 'model' && callFrame.method === 'chat'))

    const duplicate = await call('s4', 'extract', {
      memory: { version: 1, sessions: {}, workspaces: { 'w-1': { summary: { facts: ['dup', 'dup2'] }, sources: [], at: '2020-01-01T00:00:00.000Z' } } },
      workspace: 'w-1',
      summary: { facts: ['dup', 'dup2'] },
    })
    assert.deepEqual(directivesOf(duplicate.value).map((item) => item.kind), ['extern'])
    assert.equal(externOf(duplicate.value).reason, 'all_duplicate')

    console.log('直连协议：summarize / compact / extract / semantic + 写计划形状 + 不盲写其他会话')
  } finally {
    child.stdin.end()
    await waitExit(child)
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-compress-e2e-${stamp}`)
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
    assert.equal(seeded.items.length, PLUGIN_DIRS.length, 'seed 应覆盖全部五身份')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    for (const [identity] of PLUGIN_DIRS) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    console.log('离线投影：五身份在册（compress pins 解析通过）')

    await directProtocolSmoke(join(REPO_ROOT, 'plugins', 'compress', 'execute', 'main.ts'))

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
