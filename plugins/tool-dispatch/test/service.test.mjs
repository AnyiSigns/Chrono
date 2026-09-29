// `tool-dispatch` 协议级测试（node --test）：allow 扇出与保序、绑定 / 投影读、escalate / deny、
// workspace_missing、错误透传、结果缓存、verdicts 跳过 guard、caps / grant 透传、事件、fail-closed。
// 反向桥：`tool-registry.list` 复用 bag 内目录；`tool-schema.validate-args` spawn 其真实服务进程应答；
// 其余用注入假提供者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { relayFrame, serviceEntry, startBridgedService } from './bridge.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const SCHEMA_ROOT = resolve(PKG_ROOT, '..', 'tool-schema')

const PINS = {
  'tool-registry': 'tool-registry',
  'tool-schema': 'tool-schema',
  guard: 'guard',
  'tool-fs': 'tool-fs',
  'tool-shell': 'tool-shell',
  'tool-http': 'tool-http',
  'tool-browser': 'tool-browser',
  mcp: 'mcp',
  'plugin-admin': 'plugin-admin',
  'orchestration-admin': 'orchestration-admin',
  todo: 'todo',
  question: 'question',
  session: 'session',
  compress: 'compress',
  memory: 'memory-store',
  retrieval: 'memory-retrieval',
  'memory-maintenance': 'memory-consolidate',
  'evolve-metrics': 'evolve-metrics',
}

const isRec = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

function start(providers = {}) {
  const schema = startBridgedService({
    cwd: SCHEMA_ROOT,
    entry: serviceEntry(SCHEMA_ROOT),
    timeoutMs: 15000,
  })
  const dispatch = startBridgedService({
    cwd: PKG_ROOT,
    entry: ENTRY,
    timeoutMs: 15000,
    env: { CHRONO_PLUGIN_PINS: JSON.stringify(PINS) },
    async onPortCall(message) {
      const args = message.args ?? {}
      if (message.port === 'tool-schema' && message.method === 'validate-args') {
        return relayFrame(
          await schema.call(
            'tool-schema',
            'validate-args',
            { schema: args.schema ?? null, value: args.value },
            message.env,
          ),
        )
      }
      if (message.port === 'tool-registry' && message.method === 'list') {
        if (isRec(args.directory) && Array.isArray(args.directory.tools))
          return { ok: true, value: args.directory }
        if (Array.isArray(args.tools))
          return { ok: true, value: { tools: args.tools, rejected: [] } }
        return { ok: false, code: 'unresolved_cap', message: 'no directory' }
      }
      const fn = providers[message.port]?.[message.method]
      if (typeof fn === 'function') return { ok: true, value: await fn(args) }
      return {
        ok: false,
        code: 'unresolved_cap',
        message: `no provider ${String(message.port)}.${String(message.method)}`,
      }
    },
  })
  return {
    ...dispatch,
    exit: Promise.all([dispatch.exit, schema.exit]).then(([code]) => code),
    close() {
      dispatch.close()
      schema.close()
    },
  }
}

async function withService(providers, fn) {
  const drv = start(providers)
  try {
    await drv.hello('tool-dispatch')
    return await fn(drv)
  } finally {
    drv.close()
    await drv.exit
  }
}

const NO_CAPS = { fs: { read: 'none', write: 'none' }, net: 'none' }
const FS_CAPS = { fs: { read: 'workspace', write: 'none' }, net: 'none' }
const RW_CAPS = { fs: { read: 'workspace', write: 'workspace' }, net: 'none' }

function decl(name, overrides = {}) {
  return {
    name,
    provider: 'tool-fs',
    kind: 'invoke',
    method: null,
    read: null,
    intent: 'i',
    when_to_use: 'w',
    param_semantics: {},
    boundaries: 'b',
    description: 'd',
    argsSchema: { type: 'object', properties: {}, additionalProperties: true },
    caps: NO_CAPS,
    idempotent: false,
    ...overrides,
  }
}

const directory = (tools, rejected = []) => ({ tools, rejected })

const READ = decl('read', {
  param_semantics: { path: '文件路径。' },
  argsSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  caps: FS_CAPS,
  idempotent: true,
})
const EDIT = decl('edit', {
  param_semantics: { path: '文件路径。' },
  argsSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  caps: RW_CAPS,
  idempotent: false,
})
const GLOB = decl('glob', {
  param_semantics: { pattern: 'glob 模式。' },
  argsSchema: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
    additionalProperties: false,
  },
  caps: FS_CAPS,
  idempotent: false,
})
const SHELL = decl('shell', {
  provider: 'tool-shell',
  param_semantics: { input: '命令。' },
  argsSchema: {
    type: 'object',
    properties: { input: { type: 'string' } },
    required: ['input'],
    additionalProperties: false,
  },
  caps: RW_CAPS,
  idempotent: false,
})

const guardAllow = (args) => ({
  decisions: (args.calls ?? []).map((call, index) => ({
    index,
    tool: call.tool,
    verdict: 'allow',
  })),
  summary: { allow: (args.calls ?? []).length, escalate: 0, deny: 0 },
})
const guardByTool = (map) => (args) => ({
  decisions: (args.calls ?? []).map((call, index) => ({
    index,
    tool: call.tool,
    verdict: map[call.tool] ?? 'allow',
  })),
  summary: { allow: 0, escalate: 0, deny: 0 },
})

test('hello 回 manifest：能力类与方法声明一致', async () => {
  await withService({}, async (drv) => {
    const manifest = await drv.request('hello', { impl: 'tool-dispatch' }, 'manifest')
    assert.equal(manifest.identity, 'tool-dispatch')
    assert.deepEqual(manifest.methods['tool-dispatch'], ['dispatch'])
  })
})

test('allow：整批扇出、结果按 call_id 保序', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: (bag) => ({ ok: true, result: { tool: bag.tool, path: bag.args.path } }) },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: ['a', 'b', 'c'].map((id, index) => ({
        call_id: `c${index}`,
        tool: 'read',
        args: { path: `${id}.ts` },
      })),
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(response.kind, 'result', JSON.stringify(response))
    assert.deepEqual(
      response.value.results.map((item) => item.call_id),
      ['c0', 'c1', 'c2'],
    )
    assert.equal(response.value.results[2].result.path, 'c.ts')
  })
})

test('bag.directory 已给：本地索引复用，不发 tool-registry 调用（不依赖目录服务存活）', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: (bag) => ({ ok: true, result: { path: bag.args.path } }) },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(response.value.results[0].ok, true)
    assert.equal(
      drv.portCalls.some((frame) => frame.port === 'tool-registry'),
      false,
    )
  })
})

test('绑定项派发为反向 port.call（args 扁平化）；method 缺省 = 投影读', async () => {
  const providers = {
    guard: { judge: guardAllow },
    retrieval: { search: (args) => ({ ok: true, kind: 'search', echo: args.query }) },
    session: { deliver: () => ({ ok: true }) },
  }
  const binding = decl('retrieval', {
    provider: 'retrieval',
    kind: 'binding',
    method: 'search',
    argsSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      additionalProperties: true,
    },
    idempotent: true,
  })
  const projection = decl('subagent.status', {
    provider: 'session',
    kind: 'binding',
    method: null,
    argsSchema: { type: 'object', additionalProperties: true },
    idempotent: true,
  })
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'c1', tool: 'retrieval', args: { query: '记忆' } },
        { call_id: 'c2', tool: 'subagent.status', args: {} },
      ],
      directory: directory([binding, projection]),
      projection_reads: { 'subagent.status': { thread: 't-9', status: 'running' } },
      verdicts: 'allow',
    })
    assert.equal(response.value.results[0].result.echo, '记忆')
    assert.equal(response.value.results[1].result.thread, 't-9')
    assert.equal(
      drv.portCalls.some((item) => item.port === 'session'),
      false,
    )
  })
})

test('escalate / deny：零副作用、不调提供者；批级取最严', async () => {
  let invoked = 0
  const providers = {
    guard: { judge: guardByTool({ read: 'escalate', edit: 'deny' }) },
    'tool-fs': {
      invoke: () => {
        invoked += 1
        return { ok: true, result: {} }
      },
    },
  }
  await withService(providers, async (drv) => {
    const escalated = await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(escalated.value.results[0].error.code, 'needs_approval')
    const denied = await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'edit', args: { path: 'x.ts' } }],
      directory: directory([EDIT]),
      workspace_root: '/ws',
    })
    assert.equal(denied.value.results[0].error.code, 'denied')
    assert.equal(invoked, 0)
  })
})

test('workspace_missing 只对相对路径拒：绝对路径仍可派发', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: (bag) => ({ ok: true, result: { path: bag.args.path } }) },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'rel', tool: 'read', args: { path: 'src/x.ts' } },
        { call_id: 'abs', tool: 'read', args: { path: 'C:/abs/x.ts' } },
        { call_id: 'glob', tool: 'glob', args: { pattern: '**/*.ts' } },
      ],
      directory: directory([READ, GLOB]),
    })
    const byId = new Map(response.value.results.map((item) => [item.call_id, item]))
    assert.equal(byId.get('rel').error.code, 'workspace_missing')
    assert.equal(byId.get('abs').ok, true)
    assert.equal(byId.get('glob').ok, true)
  })
})

test('错误原样透传：提供者错误码不改写，失败另带 result 一并透传', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-shell': {
      invoke: () => ({
        ok: false,
        error: { code: 'nonzero_exit', message: 'exited 1' },
        result: { exit_code: 1, stdout: 'boom' },
      }),
    },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'c1', tool: 'shell', args: { input: 'ls' } },
        { call_id: 'c2', tool: 'read', args: { path: 'x.ts' } },
      ],
      directory: directory([SHELL, READ]),
      workspace_root: '/ws',
    })
    const byId = new Map(response.value.results.map((item) => [item.call_id, item]))
    assert.equal(byId.get('c1').error.code, 'nonzero_exit')
    assert.equal(byId.get('c1').result.exit_code, 1)
    assert.equal(byId.get('c2').error.code, 'unresolved_cap')
  })
})

test('结果缓存：幂等命中、写类不缓存、bag.cache=false 关闭', async () => {
  const counts = { read: 0, edit: 0 }
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': {
      invoke: (bag) => {
        if (bag.tool === 'read') counts.read += 1
        else counts.edit += 1
        return { ok: true, result: { tool: bag.tool } }
      },
    },
  }
  await withService(providers, async (drv) => {
    await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'r1', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'r2', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'e1', tool: 'edit', args: { path: 'x.ts' } },
        { call_id: 'e2', tool: 'edit', args: { path: 'x.ts' } },
      ],
      directory: directory([READ, EDIT]),
      workspace_root: '/ws',
    })
    assert.equal(counts.read, 1, '幂等工具应命中缓存')
    assert.equal(counts.edit, 2, '写类工具不应缓存')

    await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'r1', tool: 'read', args: { path: 'y.ts' } },
        { call_id: 'r2', tool: 'read', args: { path: 'y.ts' } },
      ],
      directory: directory([READ]),
      workspace_root: '/ws',
      cache: false,
    })
    assert.equal(counts.read, 3, 'bag.cache=false 应关闭缓存')
  })
})

test('bag.verdicts 已给则跳过 guard、直接消费', async () => {
  let guardCalls = 0
  let invoked = 0
  const providers = {
    guard: {
      judge: () => {
        guardCalls += 1
        return guardAllow({ calls: [] })
      },
    },
    'tool-fs': {
      invoke: () => {
        invoked += 1
        return { ok: true, result: {} }
      },
    },
  }
  await withService(providers, async (drv) => {
    await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
      verdicts: [{ call_id: 'c1', verdict: 'allow' }],
    })
    assert.equal(guardCalls, 0)
    assert.equal(invoked, 1)
  })
})

test('caps / grant / tier 透传给提供者；caps 以工具声明为准', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-shell': {
      invoke: (bag) => ({
        ok: true,
        result: { caps: bag.caps, grant: bag.grant, tier: bag.tier, root: bag.workspace_root },
      }),
    },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'shell', args: { input: 'ls' } }],
      directory: directory([SHELL]),
      workspace_root: '/ws',
      tier: 'severe',
      grant: { call_id: 'c1', op: 'exec' },
      caps: { fs: { read: 'full', write: 'full' }, net: 'all' },
    })
    const result = response.value.results[0].result
    assert.equal(result.caps.fs.read, 'workspace')
    assert.equal(result.grant.call_id, 'c1')
    assert.equal(result.tier, 'severe')
    assert.equal(result.root, '/ws')
  })
})

test('派发时发 tool.start / tool.end 事件（end 带结果本体）', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': {
      invoke: (bag) => ({
        ok: true,
        result: bag.tool === 'edit' ? { patch: 'diff' } : { text: 'body' },
      }),
    },
  }
  await withService(providers, async (drv) => {
    await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'c1', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'c2', tool: 'edit', args: { path: 'x.ts' } },
      ],
      directory: directory([READ, EDIT]),
      workspace_root: '/ws',
    })
    const start = drv.events.find((event) => event.topic === 'tool.start')
    const ends = new Map(
      drv.events
        .filter((event) => event.topic === 'tool.end')
        .map((event) => [event.payload.call_id, event.payload]),
    )
    assert.equal(start.payload.tool, 'read')
    assert.equal(ends.get('c1').result.text, 'body')
    assert.equal(ends.get('c2').result.patch, 'diff')
  })
})

test('unknown_tool / bad_args / bad_tool_decl', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: () => ({ ok: true, result: {} }) },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [
        { call_id: 'u', tool: 'nope', args: {} },
        { call_id: 'a', tool: 'read', args: {} },
        { call_id: 'd', tool: 'broken', args: {} },
      ],
      directory: directory(
        [READ],
        [{ name: 'broken', code: 'bad_tool_decl', message: 'missing boundaries' }],
      ),
      workspace_root: '/ws',
    })
    const byId = new Map(response.value.results.map((item) => [item.call_id, item]))
    assert.equal(byId.get('u').error.code, 'unknown_tool')
    assert.equal(byId.get('a').error.code, 'bad_args')
    assert.equal(byId.get('d').error.code, 'bad_tool_decl')
  })
})

test('guard 不可用 → fail-closed 全拒（不触提供者）', async () => {
  let invoked = 0
  const providers = {
    'tool-fs': {
      invoke: () => {
        invoked += 1
        return { ok: true, result: {} }
      },
    },
  }
  await withService(providers, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(response.value.results[0].error.code, 'denied')
    assert.equal(invoked, 0)
  })
})

test('目录服务不可用 → fail-closed 结构化错误（不放行未知工具）', async () => {
  await withService({ guard: { judge: guardAllow } }, async (drv) => {
    const response = await drv.call('tool-dispatch', 'dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      workspace_root: '/ws',
    })
    assert.equal(response.kind, 'error', JSON.stringify(response))
    assert.equal(response.code, 'unresolved_cap')
  })
})
