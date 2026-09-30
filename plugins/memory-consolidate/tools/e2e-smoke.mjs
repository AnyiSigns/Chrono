// `memory-consolidate` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack 依赖链（secrets → config → embedding → short-memory → model-protocol → input → compress →
// memory-store → session → memory-consolidate）→ seed → 离线读投影确认十身份在册（pins 解析通过）
// → 直连 memory-consolidate 服务协议，把反向调用桥接到内存假 owner / #20 / #19 后端
// → 覆盖 consolidate / sweep / candidates / view / edit：读 owner、算结果、写 owner，返回值为结果值。
// 说明：**不执行 `boot start`**——embedding 是 Rust 服务，物化需 cargo build 与约百 MB 权重（宿主侧 ③），
// 与本次「声明与协议就位」验收无关，故跳过；pack / seed 已覆盖插件声明、pins 与 .worldignore 的宿主门禁。
// 用法：node plugins/memory-consolidate/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { buildPeriodicBag } from '../../../packages/host/periodic-runner.ts'
import { hostPaths } from '../../../packages/host/paths.ts'
import { relayFrame, serviceEntry, startBridgedService } from '../../tools/test/bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const PLUGIN_DIRS = [
  ['input', join(REPO_ROOT, 'plugins', 'input')],
  ['session', join(REPO_ROOT, 'plugins', 'session')],
  ['short-memory', join(REPO_ROOT, 'plugins', 'short-memory')],
  ['l1-maintenance', join(REPO_ROOT, 'plugins', 'l1-maintenance')],
  ['embedding', join(REPO_ROOT, 'plugins', 'embedding')],
  ['dedup', join(REPO_ROOT, 'plugins', 'dedup')],
  ['config', join(REPO_ROOT, 'plugins', 'config')],
  ['msg-dialect', join(REPO_ROOT, 'plugins', 'msg-dialect')],
  ['secrets', join(REPO_ROOT, 'plugins', 'secrets')],
  ['throttle', join(REPO_ROOT, 'plugins', 'throttle')],
  ['model-protocol', join(REPO_ROOT, 'plugins', 'model-protocol')],
  ['semantic', join(REPO_ROOT, 'plugins', 'semantic')],
  ['summarize', join(REPO_ROOT, 'plugins', 'summarize')],
  ['compress', join(REPO_ROOT, 'plugins', 'compress')],
  ['l2-maintenance', join(REPO_ROOT, 'plugins', 'l2-maintenance')],
  ['tokenizer', join(REPO_ROOT, 'plugins', 'tokenizer')],
  ['vector-index', join(REPO_ROOT, 'plugins', 'vector-index')],
  ['memory-store', join(REPO_ROOT, 'plugins', 'memory-store')],
  ['l3-maintenance', join(REPO_ROOT, 'plugins', 'l3-maintenance')],
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
    throw new Error(
      `boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`,
    )
  }
  return parsed
}

const AT = '2023-11-14T00:00:00.000Z'
const NOW = Date.parse(AT)

function shortMemoryFixture() {
  return {
    version: 1,
    sessions: {
      'c-1': {
        summary: {
          goal: 'G1',
          decisions: [],
          facts: ['f1', 'f2'],
          open_questions: [],
          files: [],
          next_steps: [],
        },
        covered_upto: 'm1',
        at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-02T00:00:00.000Z',
      },
    },
    workspaces: {
      'w-1': {
        summary: { goal: 'WG', decisions: [], facts: ['old'], open_questions: [], files: [] },
        sources: ['c-0'],
        at: '2020-01-01T00:00:00.000Z',
      },
    },
  }
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

/** 直连 memory-consolidate 门面：spawn 真实 l1 / l2 / l3-maintenance 服务并递归路由其反向调用，
 *  owner（short-memory / session / memory）、压缩（compress）与向量化（embedding / tokenizer）叶子用内存假后端应答。 */
async function directProtocolSmoke() {
  const portCalls = []
  const applied = []
  const env = { run: 'e2e', thread: null, now: NOW }
  const state = { shortMemory: shortMemoryFixture() }

  const leaves = {
    tokenizer: {
      chunk: (args) => {
        const text = typeof args?.text === 'string' ? args.text : ''
        return [{ index: 0, start: 0, end: [...text].length, text }]
      },
    },
    embedding: {
      embed: (args) => {
        const texts = Array.isArray(args?.texts) ? args.texts : []
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
        return { model: 'granite-97m', dim: 8, vectors }
      },
    },
    'short-memory': {
      read: () => state.shortMemory,
      apply: (args) => {
        applied.push(args)
        return { ok: true, changed: 1 }
      },
    },
    session: {
      read: () => ({
        version: 1,
        current: 'c-1',
        conversations: [{ id: 'c-1', workspace_id: 'w-1' }],
      }),
    },
    memory: {
      list: () => ({ ok: true, kind: 'list', entries: [], count: 0, pinned: {} }),
      append: () => ({ ok: true, kind: 'append', added: [], count: 0 }),
    },
    compress: {
      summarize: () => ({
        $directives: [
          {
            kind: 'extern',
            payload: { ok: true, kind: 'summarize', summary: { goal: 'MERGED', facts: ['sf1'] } },
          },
        ],
      }),
    },
  }

  const roots = {
    'memory-consolidate': join(REPO_ROOT, 'plugins', 'memory-consolidate'),
    'l1-maintenance': join(REPO_ROOT, 'plugins', 'l1-maintenance'),
    'l2-maintenance': join(REPO_ROOT, 'plugins', 'l2-maintenance'),
    'l3-maintenance': join(REPO_ROOT, 'plugins', 'l3-maintenance'),
  }
  const services = {}

  async function route(frame) {
    portCalls.push(frame)
    const fake = leaves[frame.port]?.[frame.method]
    if (typeof fake === 'function') {
      try {
        const value = await fake(frame.args ?? {})
        return { ok: true, value: value === undefined ? null : value }
      } catch (err) {
        return { ok: false, code: err?.code ?? 'bridge_failed', message: String(err?.message ?? err) }
      }
    }
    const downstream = services[frame.port]
    if (downstream === undefined) {
      return { ok: false, code: 'not_ready', message: `no route ${frame.port}.${frame.method}` }
    }
    // 反向 `port.call` 帧不带 env；宿主为下游注入同一调用时钟（固定 now），供维护提供方判到期。
    return relayFrame(
      await downstream.call(frame.port, frame.method, frame.args ?? {}, frame.env ?? env),
    )
  }

  for (const [name, root] of Object.entries(roots)) {
    services[name] = startBridgedService({ cwd: root, entry: serviceEntry(root), onPortCall: route })
  }
  const mem = services['memory-consolidate']
  const call = (id, method, args) => mem.call('memory-maintenance', method, args, env)

  try {
    const manifest = await mem.hello('memory-consolidate')
    assert.equal(manifest.kind, 'manifest', 'hello 应回 manifest')
    assert.equal(manifest.identity, 'memory-consolidate')
    assert.deepEqual(manifest.methods['memory-maintenance'], [
      'consolidate',
      'sweep',
      'candidates',
      'view',
      'edit',
    ])

    const consolidated = await call('c1', 'consolidate', { weight_threshold: 1 })
    assert.equal(consolidated.kind, 'result', JSON.stringify(consolidated))
    assert.equal(consolidated.value.$directives, undefined, '不再产世界写计划')
    assert.equal(consolidated.value.kind, 'consolidate')
    assert.equal(consolidated.value.dedup, 'vector')
    const consolidatedApply = applied[applied.length - 1]
    assert.deepEqual(consolidatedApply.set_workspaces['w-1'].sources, ['c-1', 'c-0'])

    const swept = await call('c2', 'sweep', {})
    assert.deepEqual(swept.value.l1_deleted, ['c-1'])
    assert.deepEqual(applied[applied.length - 1].del_sessions, ['c-1'])

    const candidates = await call('c3', 'candidates', {})
    assert.equal(candidates.value.$directives, undefined)
    assert.equal(candidates.value.kind, 'candidates')
    assert.equal(candidates.value.candidates[0].reason, 'l1_expired')

    const viewed = await call('c4', 'view', {})
    assert.equal(viewed.value.kind, 'view')
    assert.equal(viewed.value.l1.length, 1)

    const edited = await call('c5', 'edit', { action: 'delete', layer: 'l3', id: 'missing' })
    assert.equal(edited.value.ok, false)
    assert.equal(edited.value.reason, 'not_found')

    assert.ok(portCalls.some((frame) => frame.port === 'embedding' && frame.method === 'embed'))
    assert.ok(portCalls.some((frame) => frame.port === 'short-memory' && frame.method === 'read'))
    assert.ok(portCalls.some((frame) => frame.port === 'session' && frame.method === 'read'))
    assert.ok(portCalls.some((frame) => frame.port === 'memory' && frame.method === 'list'))
    console.log(
      '直连协议：consolidate / sweep / candidates / view / edit 读 owner + 写 owner + 结果值',
    )
  } finally {
    for (const service of Object.values(services)) service.close()
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
    assert.equal(seeded.items.length, PLUGIN_DIRS.length, 'seed 应覆盖全部十身份')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head, { blobsDir: paths.blobsDir })
    for (const [identity] of PLUGIN_DIRS) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    assert.deepEqual(projection.ids['memory-consolidate'].pins, {
      'l1-maintenance': 'l1-maintenance',
      'l2-maintenance': 'l2-maintenance',
      'l3-maintenance': 'l3-maintenance',
    })
    console.log('离线投影：十身份在册（memory-consolidate pins 解析通过）')

    // `.worldignore` 门禁：源码树含 execute / schema / plugin.json，不含 test / tools。
    const commitHash = anchor.world.ids['memory-consolidate'].active
    const rootTreeHash = anchor.world.defs[commitHash]?.body?.tree
    const treePaths = collectTreePaths(anchor.world, rootTreeHash)
    assert.ok(treePaths.includes('plugin.json'), '源码树应含 plugin.json')
    assert.ok(treePaths.includes('schema/memory-maintenance.json'), '源码树应含 schema')
    assert.ok(
      treePaths.some((item) => item.startsWith('execute/')),
      '源码树应含 execute/',
    )
    assert.equal(
      treePaths.some((item) => item.startsWith('test/')),
      false,
      '.worldignore 应排除 test/',
    )
    assert.equal(
      treePaths.some((item) => item.startsWith('tools/')),
      false,
      '.worldignore 应排除 tools/',
    )
    console.log(`.worldignore：源码树 ${treePaths.length} 个文件，test/ 与 tools/ 已排除`)

    // 周期派发链路：真实 buildPeriodicBag + schema.periodic.reads + 数据世代策略 body
    // → 非空 bag 且 summarize=true（不再恒 false）；无 reads 时回 null（对照）。
    const schemaBody = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'plugins', 'memory-consolidate', 'schema', 'memory-maintenance.json'),
        'utf8',
      ),
    )
    const policyBody = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'plugins', 'memory-consolidate', 'tools', 'default-body.json'),
        'utf8',
      ),
    )
    const consolidateEntry = schemaBody.periodic.find((entry) => entry.method === 'consolidate')
    const reads = Object.entries(consolidateEntry.reads).map(([key, path]) => ({ key, path }))
    assert.equal(buildPeriodicBag({}, []), null, '无 reads 时 buildPeriodicBag 应回 null')
    const periodicBag = buildPeriodicBag(
      { ids: { 'memory-consolidate': { body: policyBody } } },
      reads,
    )
    assert.notEqual(periodicBag, null, 'buildPeriodicBag 不应回 null')
    assert.equal(periodicBag.summarize, true, '周期 bag 应带 summarize=true')
    console.log(
      '周期 bag：buildPeriodicBag 注入 summarize=true（策略 body → compress.summarize 链路不再死）',
    )

    await directProtocolSmoke()

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
