// `compress` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读 + 直连协议）：
// pack 依赖闭包（embedding / dedup / config / msg-dialect / secrets / throttle / model-protocol /
// semantic / short-memory / summarize / compress）→ seed → 离线投影确认身份在册
// → 直连 compress 门面，spawn 真实 summarize / semantic / dedup 服务并递归路由，叶子（model / embedding /
// short-memory）用内存假后端应答 → 覆盖 summarize / compact / extract / semantic：读 owner
// （short-memory.read）、写 owner（short-memory.apply），返回值即结果（不再产世界写计划）。
// 说明：**不执行 `boot start`**——embedding 是 Rust 服务，物化需 cargo build 与约百 MB 权重（宿主侧 ③），
// 与本次「声明与协议就位」验收无关，故跳过；pack / seed 已覆盖插件声明、needs 与 .worldignore 的宿主门禁。
// 用法：node plugins/compress/tools/e2e-smoke.mjs
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import { loadAnchor } from '../../../packages/host/ledger/index.ts'
import { projectBaseOnly } from '../../../packages/host/projection/index.ts'
import { hostPaths } from '../../../packages/host/paths.ts'
import { relayFrame, serviceEntry, startBridgedService } from '../../tools/test/bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BOOT_MAIN = join(REPO_ROOT, 'packages', 'boot', 'main.ts')
const PLUGIN_DIRS = [
  ['embedding', join(REPO_ROOT, 'plugins', 'embedding')],
  ['dedup', join(REPO_ROOT, 'plugins', 'dedup')],
  ['config', join(REPO_ROOT, 'plugins', 'config')],
  ['msg-dialect', join(REPO_ROOT, 'plugins', 'msg-dialect')],
  ['secrets', join(REPO_ROOT, 'plugins', 'secrets')],
  ['throttle', join(REPO_ROOT, 'plugins', 'throttle')],
  ['model-protocol', join(REPO_ROOT, 'plugins', 'model-protocol')],
  ['semantic', join(REPO_ROOT, 'plugins', 'semantic')],
  ['short-memory', join(REPO_ROOT, 'plugins', 'short-memory')],
  ['summarize', join(REPO_ROOT, 'plugins', 'summarize')],
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

/**
 * 直连 compress 门面：spawn 真实 `summarize` / `semantic` / `dedup` 服务并递归路由其反向调用，
 * 叶子（`model.chat` / `embedding.embed` / `short-memory.*`）用内存假后端应答；
 * 覆盖「薄门面经 summarize / semantic / dedup / short-memory 委派」的四条路径。
 */
async function directProtocolSmoke() {
  const applied = []
  const portCalls = []
  const state = { memory: memoryFixture() }

  const leaves = {
    model: {
      chat: () => ({ ok: true, text: JSON.stringify({ goal: 'semantic-goal', facts: ['sf1', 'sf2'] }) }),
    },
    embedding: {
      embed: () => {
        const err = new Error('e2e skips embedding')
        err.code = 'embedding_unavailable'
        throw err
      },
    },
    'short-memory': {
      read: () => state.memory,
      apply: (args) => {
        applied.push(args)
        return { ok: true, changed: 1 }
      },
    },
  }

  const roots = {
    summarize: join(REPO_ROOT, 'plugins', 'summarize'),
    semantic: join(REPO_ROOT, 'plugins', 'semantic'),
    dedup: join(REPO_ROOT, 'plugins', 'dedup'),
    compress: join(REPO_ROOT, 'plugins', 'compress'),
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
      return { ok: false, code: 'unresolved_cap', message: `no route ${frame.port}.${frame.method}` }
    }
    return relayFrame(await downstream.call(frame.port, frame.method, frame.args ?? {}, frame.env))
  }

  for (const [name, root] of Object.entries(roots)) {
    services[name] = startBridgedService({
      cwd: root,
      entry: serviceEntry(root),
      onPortCall: route,
    })
  }
  const compress = services.compress

  try {
    const manifest = await compress.hello('compress')
    assert.equal(manifest.kind, 'manifest', 'compress hello 应回 manifest')
    assert.equal(manifest.identity, 'compress')
    assert.deepEqual(manifest.methods.compress, ['summarize', 'compact', 'extract'])

    const summarized = await compress.call('compress', 'summarize', {
      conversation: 'c-1',
      covered_upto: 'msg-9',
      goal: 'G',
      facts: ['f1', 'f2'],
    })
    assert.equal(summarized.kind, 'result', JSON.stringify(summarized))
    assert.equal(summarized.value.$directives, undefined, '不再产世界写计划')
    assert.equal(summarized.value.kind, 'summarize')
    assert.equal(summarized.value.summary.goal, 'G')
    assert.equal(summarized.value.dedup, 'text')
    assert.equal(applied.length, 1, 'summarize 应写 owner 一次')
    assert.equal(applied[0].set_sessions['c-1'].summary.goal, 'G')
    assert.equal(applied[0].set_sessions['c-keep'], undefined, '不盲写其它会话')

    const compacted = await compress.call('compress', 'compact', {
      conversation: 'c-1',
      workspace: 'w-1',
      goal: 'G',
      facts: ['one', 'two', 'three'],
      decisions: ['decide'],
    })
    assert.equal(compacted.value.kind, 'compact')
    assert.ok(compacted.value.items.length >= 2 && compacted.value.items.length <= 3, `compact items=${compacted.value.items.length}`)
    const compactApply = applied[applied.length - 1]
    assert.ok(compactApply.set_sessions['c-1'] !== undefined, 'compact 写 L1')
    assert.ok(compactApply.set_workspaces['w-1'] !== undefined, 'compact 写 L2')

    const semantic = await compress.call('compress', 'summarize', {
      conversation: 'c-1',
      mode: 'semantic',
      model_config: { base_url: 'https://example.invalid', model: 'm', quirks: { impl: 'protocol', protocol: 'openai-chat' } },
      session_slice: [{ role: 'user', content: 'hi' }],
    })
    assert.equal(semantic.value.summary.goal, 'semantic-goal')
    assert.ok(portCalls.some((frame) => frame.port === 'model' && frame.method === 'chat'))

    state.memory = {
      version: 1,
      sessions: {},
      workspaces: { 'w-1': { summary: { facts: ['dup', 'dup2'] }, sources: [], at: '2020-01-01T00:00:00.000Z' } },
    }
    const duplicate = await compress.call('compress', 'extract', {
      workspace: 'w-1',
      summary: { facts: ['dup', 'dup2'] },
    })
    assert.equal(duplicate.value.$directives, undefined)
    assert.equal(duplicate.value.reason, 'all_duplicate')

    console.log('直连协议：summarize / compact / extract / semantic 读 owner + 写 owner + 结果值 + 不盲写其他会话')
  } finally {
    for (const service of Object.values(services)) service.close()
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
    assert.equal(seeded.items.length, PLUGIN_DIRS.length, 'seed 应覆盖全部闭包身份')
    console.log(`seed: ${seeded.items.map((item) => `${item.name}=${item.status}`).join(' ')}`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    for (const [identity] of PLUGIN_DIRS) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    console.log('离线投影：闭包身份在册（compress needs 解析通过）')

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
