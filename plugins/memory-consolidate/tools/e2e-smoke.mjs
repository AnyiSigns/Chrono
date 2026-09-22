// `memory-consolidate` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack 依赖链（secrets → model-protocol → embedding → short-memory → compress → session → memory-store → memory-consolidate）
// → seed → 离线读投影确认八身份在册（pins 解析通过）→ 直连 memory-consolidate 服务协议，把反向调用
// 桥接到内存假 #20 / #19 后端 → 覆盖 consolidate / sweep / candidates / view 与写计划形状。
// 说明：**不执行 `boot start`**——embedding 是 Rust 服务，物化需 cargo build 与约百 MB 权重（宿主侧 ③），
// 与本次「声明与协议就位」验收无关，故跳过；pack / seed 已覆盖插件声明、pins 与 .worldignore 的宿主门禁。
// 用法：node plugins/memory-consolidate/tools/e2e-smoke.mjs
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
  ['session', join(REPO_ROOT, 'plugins', 'session')],
  ['memory-store', join(REPO_ROOT, 'plugins', 'memory-store')],
  ['memory-consolidate', join(REPO_ROOT, 'plugins', 'memory-consolidate')],
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

const AT = '2023-11-14T00:00:00.000Z'
const NOW = Date.parse(AT)

function shortMemoryFixture() {
  return {
    version: 1,
    sessions: {
      'c-1': {
        summary: { goal: 'G1', decisions: [], facts: ['f1', 'f2'], open_questions: [], files: [], next_steps: [] },
        covered_upto: 'm1',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
    },
    workspaces: {
      'w-1': { summary: { goal: 'WG', decisions: [], facts: ['old'], open_questions: [], files: [] }, sources: ['c-0'], at: '2020-01-01T00:00:00.000Z' },
    },
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

/** 递归收集某 commit 源码树内的全部路径（验证 `.worldignore` 排除生效）。 */
function collectTreePaths(world, rootHash, prefix = '') {
  const body = world.defs[rootHash]?.body
  const entries = Array.isArray(body?.entries) ? body.entries : []
  const paths = []
  for (const entry of entries) {
    const name = entry.name
    const path = prefix.length === 0 ? name : `${prefix}/${name}`
    if (entry.mode === 'dir') paths.push(...collectTreePaths(world, entry.hash, path))
    else paths.push(path)
  }
  return paths
}

/** 直连 memory-consolidate 服务 stdio，把 `port.call` 桥接到内存假 #20 / #19 后端。 */
async function directProtocolSmoke(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const next = frameReader(child)
  const portCalls = []
  const env = { run: 'e2e', thread: null, now: NOW }

  async function bridge(message) {
    portCalls.push(message)
    if (message.port === 'embedding' && message.method === 'chunk') {
      const text = typeof message.args?.text === 'string' ? message.args.text : ''
      child.stdin.write(
        encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: [{ index: 0, start: 0, end: [...text].length, text }] }),
      )
      return
    }
    if (message.port === 'embedding' && message.method === 'embed') {
      const texts = Array.isArray(message.args?.texts) ? message.args.texts : []
      const vectors = texts.map((text) => {
        const vector = new Array(8).fill(0)
        let hash = 0x811c9dc5
        for (const ch of text) {
          hash ^= ch.codePointAt(0)
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
        vector[hash % 8] = 1
        return vector
      })
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { model: 'granite-97m', dim: 8, vectors } }))
      return
    }
    if (message.port === 'compress' && message.method === 'summarize') {
      child.stdin.write(
        encodeFrame({
          v: '1',
          id: message.id,
          kind: 'port.result',
          ok: true,
          value: { $directives: [{ kind: 'extern', payload: { ok: true, kind: 'summarize', summary: { goal: 'MERGED', facts: ['sf1'] } } }] },
        }),
      )
      return
    }
    child.stdin.write(
      encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'not_ready', message: 'no resolver' }),
    )
  }

  async function call(id, method, args) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'memory-maintenance', method, args, env }))
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
    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'memory-consolidate' }))
    const manifest = await next()
    assert.equal(manifest.kind, 'manifest', 'hello 应回 manifest')
    assert.equal(manifest.identity, 'memory-consolidate')
    assert.deepEqual(manifest.methods['memory-maintenance'], ['consolidate', 'sweep', 'candidates', 'view', 'edit'])

    const consolidated = await call('c1', 'consolidate', {
      short_memory: shortMemoryFixture(),
      session: { current: 'c-1', conversations: [{ id: 'c-1', workspace_id: 'w-1' }] },
      memory_store: { tail: null, count: 0, deleted: {}, pinned: {}, model: { id: 'granite-97m', dim: 384 } },
      memory_store_refs: {},
      weight_threshold: 1,
    })
    assert.equal(consolidated.kind, 'result', JSON.stringify(consolidated))
    const consolidatedOps = opsOf(consolidated.value)
    assert.deepEqual(consolidatedOps.map((op) => op.op), ['put', 'add_gen'])
    assert.equal(consolidatedOps[1].args.id, 'short-memory')
    assert.deepEqual(consolidatedOps[0].args.body.workspaces['w-1'].sources, ['c-1', 'c-0'])
    assert.equal(externOf(consolidated.value).dedup, 'vector')

    const swept = await call('c2', 'sweep', {
      short_memory: shortMemoryFixture(),
      memory_store: { tail: null, count: 0, deleted: {}, pinned: {}, model: { id: 'granite-97m', dim: 384 } },
      memory_store_refs: {},
    })
    assert.deepEqual(externOf(swept.value).l1_deleted, ['c-1'])
    assert.deepEqual(opsOf(swept.value).map((op) => op.op), ['put', 'add_gen'])

    const candidates = await call('c3', 'candidates', {
      short_memory: shortMemoryFixture(),
      memory_store: { tail: null, count: 0, deleted: {}, pinned: {}, model: { id: 'granite-97m', dim: 384 } },
      memory_store_refs: {},
    })
    assert.equal(candidates.value.$directives, undefined)
    assert.equal(candidates.value.candidates[0].reason, 'l1_expired')

    const viewed = await call('c4', 'view', {
      short_memory: shortMemoryFixture(),
      memory_store: { tail: null, count: 0, deleted: {}, pinned: {}, model: { id: 'granite-97m', dim: 384 } },
      memory_store_refs: {},
    })
    assert.equal(viewed.value.kind, 'view')
    assert.equal(viewed.value.l1.length, 1)
    assert.ok(portCalls.some((frame) => frame.port === 'embedding' && frame.method === 'embed'))

    console.log('直连协议：consolidate / sweep / candidates / view + 写计划形状')
  } finally {
    child.stdin.end()
    await waitExit(child)
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-memory-consolidate-e2e-${stamp}`)
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
    assert.equal(seeded.items.length, PLUGIN_DIRS.length, 'seed 应覆盖全部八身份')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    for (const [identity] of PLUGIN_DIRS) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    const consolidatePins = projection.ids['memory-consolidate'].pins
    assert.deepEqual(consolidatePins, { compress: 'compress', embedding: 'embedding', memory: 'memory-store' })
    console.log('离线投影：八身份在册（memory-consolidate pins 解析通过）')

    // `.worldignore` 门禁：源码树含 execute / schema / plugin.json，不含 test / tools。
    const commitHash = anchor.world.ids['memory-consolidate'].active
    const rootTreeHash = anchor.world.defs[commitHash]?.body?.tree
    const treePaths = collectTreePaths(anchor.world, rootTreeHash)
    assert.ok(treePaths.includes('plugin.json'), '源码树应含 plugin.json')
    assert.ok(treePaths.includes('schema/memory-maintenance.json'), '源码树应含 schema')
    assert.ok(treePaths.some((item) => item.startsWith('execute/')), '源码树应含 execute/')
    assert.equal(treePaths.some((item) => item.startsWith('test/')), false, '.worldignore 应排除 test/')
    assert.equal(treePaths.some((item) => item.startsWith('tools/')), false, '.worldignore 应排除 tools/')
    console.log(`.worldignore：源码树 ${treePaths.length} 个文件，test/ 与 tools/ 已排除`)

    await directProtocolSmoke(join(REPO_ROOT, 'plugins', 'memory-consolidate', 'execute', 'main.ts'))

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
