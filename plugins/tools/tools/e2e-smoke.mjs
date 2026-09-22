// `tools` 宿主装配 E2E（黑盒，经 boot CLI + 离线投影读）：
// pack 依赖闭包（全部 pins 及其传递依赖，按拓扑序）→ seed → 离线投影确认身份在册（pins 解析通过）
// → 直连 tools 服务协议，把反向调用桥接到内存假提供者 → 覆盖 list（并集 / 绑定 / MCP / 拒绝）与 dispatch。
// 说明：**不执行 `boot start`**——闭包里含 Rust 服务（sandbox / embedding / memory-retrieval / tool-fs），
// 物化需 cargo build，与本次「声明 / pins / .worldignore 就位」验收无关，故跳过；pack / seed 已覆盖宿主门禁。
// 用法：node plugins/tools/tools/e2e-smoke.mjs
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

// 拓扑序：被依赖者先 pack（pins 解析要求目标身份已在世界里）。
const PLUGIN_ORDER = [
  'secrets',
  'sandbox',
  'embedding',
  'model-protocol',
  'session',
  'guard',
  'orchestration-admin',
  'todo',
  'question',
  'memory-store',
  'compress',
  'memory-retrieval',
  'memory-consolidate',
  'tool-fs',
  'tool-shell',
  'tool-http',
  'tool-browser',
  'mcp',
  'plugin-admin',
  'evolve-metrics',
  'tools',
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

const READ_TOOL = {
  name: 'read',
  intent: '读取一个文本文件的内容。',
  when_to_use: '需要查看文件内容时。',
  param_semantics: { path: '文件路径。' },
  boundaries: '只读单文件。',
  description: '读文本文件。',
  argsSchema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 } },
    required: ['path'],
    additionalProperties: false,
  },
  caps: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
  idempotent: true,
  render: { form: 'line', label: 'read', summary: '{path}' },
}

const RETRIEVAL_BINDING = {
  class: 'retrieval',
  method: 'search',
  intent: '语义召回长期记忆。',
  when_to_use: '需要召回记忆时。',
  param_semantics: { query: '检索词。' },
  boundaries: '只读检索。',
  argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: true },
  caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
  idempotent: true,
}

// #44 `record` 的规范绑定项（工具名 `record` 直绑 `evolve-metrics.record`）。
const RECORD_BINDING = {
  class: 'evolve-metrics',
  method: 'record',
  intent: '把用户原始请求落成一条 user_request 证据。',
  when_to_use: '用户驱动结构变更、需先留证再交提案时。',
  param_semantics: {
    user_message_def: '本回合首条用户消息 def（由调用方在派发时注入）。',
    workspace_id: '证据所属工作区 id。',
  },
  boundaries: '只产证据、不产提案、不发 eff。',
  // 两个参数由调用方在派发时注入（模型不知哈希），故声明为可选、不 required。
  argsSchema: {
    type: 'object',
    properties: { user_message_def: {}, workspace_id: { type: 'string' } },
    additionalProperties: true,
  },
  caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
  idempotent: false,
  render: { form: 'card', label: 'record', summary: 'record  {result.evidence_id}', tone: 'plain', detail: { kind: 'json' } },
}

const MCP_TOOL = {
  name: 'mcp.demo.echo',
  intent: '外部回声。',
  when_to_use: '需要外部回声时。',
  param_semantics: { text: '文本。' },
  boundaries: '外部工具。',
  argsSchema: { type: 'object', properties: { text: { type: 'string' } } },
  caps: { fs: { read: 'none', write: 'none' }, net: false },
  idempotent: false,
}

/** 直连 tools 服务 stdio，把 `port.call` 桥接到内存假提供者。 */
async function directProtocolSmoke(entry) {
  const child = spawn(process.execPath, [entry], {
    cwd: dirname(dirname(entry)),
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const next = frameReader(child)
  const env = { run: 'e2e', thread: null, now: 1_700_000_000_000 }

  async function bridge(message) {
    if (message.port === 'tool-fs' && message.method === 'describe') {
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { tools: [READ_TOOL] } }))
      return
    }
    if (message.port === 'tool-fs' && message.method === 'invoke') {
      const value = { ok: true, result: { path: message.args.args.path } }
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value }))
      return
    }
    if (message.port === 'guard' && message.method === 'judge') {
      const calls = Array.isArray(message.args.calls) ? message.args.calls : []
      const decisions = calls.map((call, index) => ({ index, port: call.port, tool: call.tool, verdict: 'allow', reason: 'e2e' }))
      child.stdin.write(
        encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { decisions, summary: { allow: calls.length, escalate: 0, deny: 0 } } }),
      )
      return
    }
    if (message.port === 'retrieval' && message.method === 'search') {
      child.stdin.write(
        encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value: { ok: true, kind: 'search', hits: [] } }),
      )
      return
    }
    if (message.port === 'evolve-metrics' && message.method === 'record') {
      const value = { evidence_id: 'ev-1', workspace_id: message.args.workspace_id, $directives: [] }
      child.stdin.write(encodeFrame({ v: '1', id: message.id, kind: 'port.result', ok: true, value }))
      return
    }
    child.stdin.write(
      encodeFrame({ v: '1', id: message.id, kind: 'port.error', ok: false, error: 'unresolved_cap', message: `${message.port}.${message.method}` }),
    )
  }

  async function call(id, method, args) {
    child.stdin.write(encodeFrame({ v: '1', id, kind: 'call', port: 'tools', method, args, env }))
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
    child.stdin.write(encodeFrame({ v: '1', id: 'h', kind: 'hello', impl: 'tools' }))
    const manifest = await next()
    assert.equal(manifest.kind, 'manifest', 'tools hello 应回 manifest')
    assert.equal(manifest.identity, 'tools')
    assert.deepEqual(manifest.methods.tools, ['list', 'dispatch'])

    const listed = await call('l1', 'list', {
      tools_bindings: { retrieval: RETRIEVAL_BINDING, record: RECORD_BINDING },
      mcp_tools: [MCP_TOOL],
    })
    assert.equal(listed.kind, 'result', JSON.stringify(listed))
    const names = listed.value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['mcp.demo.echo', 'read', 'record', 'retrieval'])
    assert.equal(listed.value.rejected.length, 0)
    const record = listed.value.tools.find((tool) => tool.name === 'record')
    assert.equal(record.provider, 'evolve-metrics')
    assert.equal(record.kind, 'binding')
    assert.equal(record.method, 'record')
    assert.equal(record.idempotent, false)

    const dispatched = await call('d1', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'src/main.ts' } }],
      directory: listed.value,
      workspace_root: '/ws',
    })
    assert.equal(dispatched.kind, 'result', JSON.stringify(dispatched))
    assert.equal(dispatched.value.results[0].ok, true)
    assert.equal(dispatched.value.results[0].result.path, 'src/main.ts')

    const recorded = await call('d2', 'dispatch', {
      calls: [{ call_id: 'c2', tool: 'record', args: {} }],
      directory: listed.value,
      user_message_def: { def: 'msg-h1' },
      workspace_id: 'ws-1',
    })
    assert.equal(recorded.kind, 'result', JSON.stringify(recorded))
    assert.equal(recorded.value.results[0].ok, true, JSON.stringify(recorded.value.results[0]))
    assert.equal(recorded.value.results[0].result.evidence_id, 'ev-1')

    console.log('直连协议：list（describe + 绑定 + MCP 并集，含 record）与 dispatch（guard 兜底 + 扇出 + record→evolve-metrics.record）就位')
  } finally {
    child.stdin.end()
    await waitExit(child)
  }
}

function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const root = join(tmpdir(), 'kilo', `chrono-tools-e2e-${stamp}`)
  mkdirSync(join(root, 'state'), { recursive: true })
  try {
    for (const identity of PLUGIN_ORDER) {
      const dir = join(REPO_ROOT, 'plugins', identity)
      const packed = boot(root, ['pack', dir, '--identity', identity])
      assert.equal(packed.ok, true, `pack ${identity} 报告 ok:false：${JSON.stringify(packed)}`)
      console.log(`pack ${identity}: ${packed.status}`)
    }

    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify(PLUGIN_ORDER.map((identity) => ({ name: identity, path: join(REPO_ROOT, 'plugins', identity) }))),
    )

    const seeded = boot(root, ['seed'])
    assert.equal(seeded.ok, true, 'seed 报告 ok:false')
    assert.equal(seeded.items.length, PLUGIN_ORDER.length, 'seed 应覆盖全部身份')
    console.log(`seed: ${seeded.items.length} 身份`)

    const paths = hostPaths(root)
    const anchor = loadAnchor(paths.journalFile, paths.baseFile, paths.coldDir)
    const projection = projectBaseOnly(anchor.world, anchor.head)
    for (const identity of PLUGIN_ORDER) {
      assert.ok(projection.ids[identity] !== undefined, `投影缺身份 ${identity}`)
    }
    const toolsPins = projection.ids.tools.pins
    assert.equal(toolsPins['tool-fs'], 'tool-fs')
    assert.equal(toolsPins['memory'], 'memory-store')
    assert.equal(toolsPins['host'], 'host')
    assert.equal(toolsPins['evolve-metrics'], 'evolve-metrics')
    assert.ok(projection.ids['evolve-metrics'] !== undefined, '投影缺身份 evolve-metrics')
    console.log('离线投影：闭包身份在册（含 evolve-metrics）、tools pins 解析通过')

    directProtocolSmoke(join(REPO_ROOT, 'plugins', 'tools', 'execute', 'main.ts'))
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
