// `memory-store` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack 依赖链（embedding → memory-store）→ seed → 离线读投影确认两身份在册、pins 解析通过
// → 校验 `.worldignore` 门禁（test/ / tools/ 未入源码树，契约与成员文件在册）
// → 直连 memory-store 服务协议，把反向调用桥接到内存假向量化后端
// → 覆盖 put / read / search / delete：条目与 body 写自有持久存储（④），重启后仍可读回；返回值为结果值。
// 说明：**不执行 `boot start`**——embedding 是 Rust 服务，物化需 cargo build 与约百 MB 权重（宿主侧 ③），
// 与本次「声明与协议就位」验收无关，故跳过；pack / seed 已覆盖插件声明、pins 与 .worldignore 的宿主门禁。
// 用法：node plugins/memory-store/tools/e2e-smoke.mjs
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
  ['embedding', join(REPO_ROOT, 'plugins', 'embedding')],
  ['memory-store', join(REPO_ROOT, 'plugins', 'memory-store')],
]
const DIM = 384
const ENV = { run: 'e2e', thread: null, now: 1_700_000_000_000 }

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

function fnv1a(text) {
  let hash = 0x811c9dc5
  for (const ch of text) {
    hash ^= ch.codePointAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function testVector(text) {
  const vector = new Array(DIM).fill(0)
  vector[fnv1a(text) % DIM] = 1
  return vector
}

/** 递归收集某身份源码树里的文件 / 目录路径（投影不含 tree / blob，故直接读世界 defs）。 */
function collectSourcePaths(world, identity) {
  const active = world.ids[identity]?.active
  const commit = active === null || active === undefined ? undefined : world.defs[active]
  const treeHash = commit?.body?.tree
  const paths = []
  const visit = (hash, prefix) => {
    const tree = world.defs[hash]
    const entries = tree?.body?.entries
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      paths.push(path)
      if (entry.mode === 'dir') visit(entry.hash, path)
    }
  }
  if (typeof treeHash === 'string') visit(treeHash, '')
  return paths
}

/** 直连 memory-store 服务 stdio，把 `port.call` 桥接到内存假向量化后端。 */
async function openSession(entry, dataDir, stateDir) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)),
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, CHRONO_PLUGIN_DATA: dataDir, CHRONO_PLUGIN_STATE: stateDir },
  })
  const next = frameReader(child)
  const portCalls = []

  function bridge(message) {
    portCalls.push(message)
    if (message.port === 'embedding' && message.method === 'chunk') {
      const text = typeof message.args?.text === 'string' ? message.args.text : ''
      const value = [{ index: 0, start: 0, end: [...text].length, text }]
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value }))
      return
    }
    if (message.port === 'embedding' && message.method === 'embed') {
      const texts = Array.isArray(message.args?.texts) ? message.args.texts : []
      const value = { model: 'granite-97m', dim: DIM, vectors: texts.map((text) => testVector(text)) }
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
        message: 'e2e bridge has no such method',
      }),
    )
  }

  async function call(id, method, args) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'memory', method, args, env: ENV }))
    for (;;) {
      const message = await next()
      if (message.kind === 'port.call') {
        bridge(message)
        continue
      }
      if ((message.kind === 'result' || message.kind === 'error') && message.id === id) return message
    }
  }

  child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'memory-store' }))
  const manifest = await next()
  return {
    manifest,
    portCalls,
    call,
    close: async () => {
      child.stdin.end()
      await waitExit(child)
    },
  }
}

async function directProtocolSmoke(entry, dataDir, stateDir) {
  let entryId = null
  const first = await openSession(entry, dataDir, stateDir)
  try {
    assert.equal(first.manifest.kind, 'manifest', 'memory-store hello 应回 manifest')
    assert.equal(first.manifest.identity, 'memory-store')
    assert.deepEqual(first.manifest.methods.memory, ['put', 'read', 'search', 'list', 'append', 'delete', 'pin', 'edit'])

    const put = await first.call('p1', 'put', { text: 'alpha' })
    assert.equal(put.kind, 'result', JSON.stringify(put))
    assert.equal(put.value.$directives, undefined, '运行记录不产世界写计划')
    assert.equal(put.value.ok, true)
    assert.equal(put.value.saved, true)
    assert.equal(put.value.count, 1)
    entryId = put.value.id
    assert.ok(typeof entryId === 'string' && entryId.length > 0)

    const read = await first.call('r1', 'read', { hashes: [entryId, 'h-missing'] })
    assert.equal(read.value.entries[0].entry.text, 'alpha')
    assert.deepEqual(read.value.missing, ['h-missing'])

    const search = await first.call('s1', 'search', { query_vector: testVector('alpha'), top_k: 3 })
    assert.equal(search.value.status, 'ready', JSON.stringify(search.value))
    assert.equal(search.value.hits[0].entry_hash, entryId)
    assert.equal(search.value.hits[0].score, 1)

    const list = await first.call('l1', 'list', {})
    assert.deepEqual(list.value.entries.map((item) => item.id), [entryId])

    assert.ok(first.portCalls.some((frame) => frame.port === 'embedding' && frame.method === 'chunk'))
    assert.ok(first.portCalls.some((frame) => frame.port === 'embedding' && frame.method === 'embed'))
    console.log('直连协议：put / read / search / list + 结果值 + 不产世界写计划')
  } finally {
    await first.close()
  }

  // 重启（同一 ④ 目录）：条目与 body 从追加日志重放，仍可读回。
  const second = await openSession(entry, dataDir, stateDir)
  try {
    const read = await second.call('r2', 'read', { hashes: [entryId] })
    assert.equal(read.value.entries[0].entry.text, 'alpha', '重启后应能读回条目（④ 持久化）')

    const removed = await second.call('d1', 'delete', { ids: [entryId], at: '2020-01-01T00:00:00.000Z' })
    assert.deepEqual(removed.value.deleted, [entryId])
    const filtered = await second.call('s2', 'search', { query_vector: testVector('alpha'), top_k: 3 })
    assert.deepEqual(filtered.value.hits, [], '逻辑删除后不再命中')
    console.log('重启读回：④ 追加日志重放；delete 后 search 过滤')
  } finally {
    await second.close()
  }
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-memory-store-e2e-${stamp}`)
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
    assert.equal(seeded.items.length, PLUGIN_DIRS.length, 'seed 应覆盖两身份')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head, { blobsDir: paths.blobsDir })
    for (const [identity] of PLUGIN_DIRS) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    assert.deepEqual(projection.ids['memory-store'].pins, { embedding: 'embedding' }, 'memory-store pins 应解析为 embedding')
    console.log('离线投影：两身份在册，memory-store pins 解析通过')

    const sourcePaths = collectSourcePaths(anchor.world, 'memory-store')
    assert.ok(sourcePaths.includes('plugin.json'), '源码树应含 plugin.json')
    assert.ok(sourcePaths.includes('package.json'), '源码树应含 package.json')
    assert.ok(sourcePaths.includes('README.md'), '源码树应含 README.md')
    assert.ok(sourcePaths.includes('execute'), '源码树应含 execute/')
    assert.ok(sourcePaths.includes('schema'), '源码树应含 schema/')
    assert.equal(sourcePaths.some((path) => path === 'test' || path.startsWith('test/')), false, '.worldignore 应排除 test/')
    assert.equal(sourcePaths.some((path) => path === 'tools' || path.startsWith('tools/')), false, '.worldignore 应排除 tools/')
    console.log(`.worldignore 门禁：test/ 与 tools/ 未入源码树（共 ${sourcePaths.length} 项）`)

    await directProtocolSmoke(
      join(REPO_ROOT, 'plugins', 'memory-store', 'execute', 'main.ts'),
      join(root, 'data', 'memory-store'),
      join(root, 'state', 'plugins', 'memory-store'),
    )

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
