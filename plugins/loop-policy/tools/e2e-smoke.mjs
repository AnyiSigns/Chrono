// `loop-policy` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读 + 直连协议）：
// pack 依赖闭包（全部 needs 提供方及其传递依赖，按拓扑序）→ seed → 离线投影确认身份在册、有效 pins 解析通过
// → 直连 loop-policy 门面，把 graph-run / turn-ledger / session 反向调用按帧桩应答 → 覆盖 interpret 委派与收口。
// 说明：**不执行 `boot start`**——闭包里含 Rust 服务（sandbox / embedding / evolve-metrics / tool-fs），
// 物化需 cargo build，与本次「声明 / needs / .worldignore 就位」验收无关；pack / seed 已覆盖宿主门禁。
// 用法：node plugins/loop-policy/tools/e2e-smoke.mjs
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

// 拓扑序：被依赖者先 pack。含 loop-policy `needs` 的传递闭包（每个 `one` 需求恰好一个提供方）。
const PLUGIN_ORDER = [
  'approval',
  'tokenizer',
  'embedding-local',
  'embedding',
  'config',
  'msg-dialect',
  'secrets-env',
  'secrets-local',
  'secrets',
  'throttle',
  'model-protocol',
  'token-estimate',
  'budget',
  'context-window',
  'evolve-ledger',
  'evolve-evidence',
  'evolve-shadow',
  'evolve-sweep',
  'evolve-metrics',
  'graph-gate',
  'guard',
  'vector-index',
  'router',
  'input',
  'session',
  'mcp-client',
  'mcp',
  'orchestration',
  'orchestration-admin',
  'plugin',
  'plugin-admin',
  'question',
  'storage-kv',
  'todo',
  'sandbox-policy',
  'sandbox-exec',
  'sandbox-fs',
  'sandbox',
  'tool-browser',
  'tool-fs',
  'tool-http',
  'tool-shell',
  'tool-registry',
  'tool-dispatch',
  'tools',
  'graph-run',
  'ref-hydrate',
  'turn-ledger',
  'loop-policy',
]

// 有效 pins = 声明的 `pins`（host）∪ 全部 `one` needs 绑定（名 → 提供方身份名）。
const EXPECTED_PINS = {
  host: 'host',
  'graph-run': 'graph-run',
  'turn-ledger': 'turn-ledger',
  'ref-hydrate': 'ref-hydrate',
  session: 'session',
  model: 'model-protocol',
  context: 'context-window',
  guard: 'guard',
  'graph-gate': 'graph-gate',
  approval: 'approval',
  'tool-dispatch': 'tool-dispatch',
  router: 'router',
  'evolve-metrics': 'evolve-metrics',
}

function boot(root, args) {
  const result = spawnSync(process.execPath, [BOOT_MAIN, ...args, '--root', root], { encoding: 'utf8', cwd: REPO_ROOT })
  const stdout = result.stdout.trim()
  let parsed = null
  if (stdout.length > 0) {
    try {
      parsed = JSON.parse(stdout)
    } catch {
      parsed = null
    }
  }
  if (result.status !== 0) throw new Error(`boot ${args.join(' ')} 失败（exit ${result.status}）：${result.stderr || stdout}`)
  return parsed
}

function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  return Buffer.concat([header, body])
}

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

function summaryOf(value) {
  for (const directive of value.$directives ?? []) {
    if (directive.kind === 'extern' && directive.payload?.kind === 'interpret') return directive.payload
  }
  return null
}

/** 直连 loop-policy 服务，把 `port.call` 桥接到内存假节点提供者。 */
async function directProtocolSmoke(entry) {
  const child = spawn(process.execPath, [entry], { cwd: dirname(dirname(entry)), stdio: ['pipe', 'pipe', 'inherit'] })
  const next = frameReader(child)
  const env = { run: 'e2e', thread: null, now: 1_700_000_000_000 }
  const seen = []

  // 门面已薄化：编排重力在 graph-run（图执行）与 turn-ledger（回合并账）；两者作为外部提供方按帧桩应答，
  // 只验证 loop-policy 的委派顺序、结局归一与会话收口。
  async function bridge(message) {
    const key = `${message.port}.${message.method}`
    seen.push(key)
    let value
    if (key === 'graph-run.run') {
      value = {
        directives: [],
        pending: null,
        summary: { ok: true, kind: 'interpret', iters: 1, steps: 0, branch_not_taken: 0, instances: [] },
        ended: 'done',
        lifecycle: 'settled',
        progress: { iter: 1, node_index: null, contract_id: null },
        stop_reason: null,
        trace: { steps: [], branch_not_taken: 0, refused_at: null },
      }
    } else if (key === 'turn-ledger.settle') {
      value = { extra: [], batch: [] }
    } else if (key === 'ref-hydrate.hydrate') {
      value = {}
    } else if (key === 'session.turn_settle') {
      value = { ok: true, turn_id: message.args.turn_id, outcome: message.args.outcome, persisted: true }
    } else {
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'unresolved_cap', message: key }))
      return
    }
    child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value }))
  }

  async function call(id, args) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'loop-policy', method: 'interpret', args, env }))
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
    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'loop-policy' }))
    const manifest = await next()
    assert.equal(manifest.kind, 'manifest')
    assert.equal(manifest.identity, 'loop-policy')
    assert.deepEqual(manifest.methods['loop-policy'], ['interpret', 'cancel'])

    const result = await call('i1', { turn_id: 't1' })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.ok(Array.isArray(result.value.$directives))
    const summary = summaryOf(result.value)
    assert.equal(summary.ended, 'done')
    assert.equal(summary.settled, true)
    assert.equal(summary.fell_back, true)
    assert.deepEqual(seen, ['graph-run.run', 'turn-ledger.settle', 'session.turn_settle'])
    console.log('直连协议：interpret 委派 graph-run.run → turn-ledger.settle → session.turn_settle，结局归一为 done')
  } finally {
    child.stdin.end()
    await waitExit(child)
  }
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-loop-policy-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  try {
    for (const identity of PLUGIN_ORDER) {
      const dir = join(REPO_ROOT, 'plugins', identity)
      const packed = boot(root, ['pack', dir, '--identity', identity])
      assert.equal(packed.ok, true, `pack ${identity} 报告 ok:false：${JSON.stringify(packed)}`)
    }
    console.log(`pack: ${PLUGIN_ORDER.length} 身份（闭包按拓扑序）`)

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(PLUGIN_ORDER.map((identity) => ({ name: identity, path: join(REPO_ROOT, 'plugins', identity) }))),
    )
    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    assert.equal(seeded.items.length, PLUGIN_ORDER.length)
    console.log(`seed: ${seeded.items.length} 身份`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head, { blobsDir: paths.blobsDir })
    const loopPolicy = projection.ids['loop-policy']
    assert.ok(loopPolicy, '投影缺 loop-policy')
    assert.deepEqual(loopPolicy.pins, EXPECTED_PINS, 'loop-policy 有效 pins 应解析为提供方身份名')
    assert.ok(loopPolicy.gens.length >= 1, 'loop-policy 应有代码世代')
    for (const target of Object.values(EXPECTED_PINS)) {
      if (target === 'host') continue
      assert.ok(projection.ids[target], `pins 目标缺身份 ${target}`)
    }
    console.log(`离线投影：有效 pins ${Object.keys(EXPECTED_PINS).length} 项解析通过、身份与世代正确`)

    directProtocolSmoke(join(REPO_ROOT, 'plugins', 'loop-policy', 'execute', 'main.ts'))
      .then(() => {
        const verified = boot(root, ['verify'])
        assert.equal(verified.ok, true, `verify 失败：${JSON.stringify(verified)}`)
        console.log('verify：ok')
        console.log(`E2E ok（root=${root}）`)
      })
      .catch((err) => {
        console.error(err.stack || err.message)
        process.exitCode = 1
      })
  } catch (err) {
    console.error(err.stack || err.message)
    process.exitCode = 1
  }
}

main()
