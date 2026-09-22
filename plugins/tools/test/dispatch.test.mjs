// dispatch 测试：allow 并发扇出与保序、并发上限、绑定派发 / 投影读、escalate 标记、deny 零副作用、
// workspace_missing 只对相对路径拒、错误原样透传、结果缓存、verdicts 跳过 guard、caps / grant 透传、事件。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService, guardAllow, guardByTool, recordBinding } from './driver.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const FS_CAPS = { fs: { read: 'workspace', write: 'none' }, net: 'none' }
const RW_CAPS = { fs: { read: 'workspace', write: 'workspace' }, net: 'none' }
const NO_CAPS = { fs: { read: 'none', write: 'none' }, net: 'none' }

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

function directory(tools, rejected = []) {
  return { tools, rejected }
}

async function withService(providers, fn) {
  const service = startService({ providers })
  try {
    await service.hello()
    return await fn(service)
  } finally {
    service.close()
  }
}

const READ = decl('read', {
  param_semantics: { path: '文件路径。' },
  argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  caps: FS_CAPS,
  idempotent: true,
})
const EDIT = decl('edit', {
  param_semantics: { path: '文件路径。' },
  argsSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  caps: RW_CAPS,
  idempotent: false,
})
const GLOB = decl('glob', {
  param_semantics: { pattern: 'glob 模式。' },
  argsSchema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'], additionalProperties: false },
  caps: FS_CAPS,
  idempotent: false,
})
const SHELL = decl('shell', {
  provider: 'tool-shell',
  param_semantics: { input: '命令。' },
  argsSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
  caps: RW_CAPS,
  idempotent: false,
})

test('allow：整批并发扇出、结果按 call_id 保序、并发 > 1', async () => {
  const state = { current: 0, max: 0 }
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': {
      invoke: async (bag) => {
        state.current += 1
        state.max = Math.max(state.max, state.current)
        await sleep(25)
        state.current -= 1
        return { ok: true, result: { tool: bag.tool, path: bag.args.path } }
      },
    },
  }
  const tools = [READ]
  const calls = ['a', 'b', 'c', 'd'].map((id, index) => ({ call_id: `c${index}`, tool: 'read', args: { path: `${id}.ts` } }))
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls,
      directory: directory(tools),
      workspace_root: '/ws',
      concurrency: 4,
    })
    assert.equal(response.kind, 'result', JSON.stringify(response))
    const results = response.value.results
    assert.deepEqual(results.map((item) => item.call_id), ['c0', 'c1', 'c2', 'c3'])
    assert.ok(results.every((item) => item.ok === true))
    assert.equal(results[2].result.path, 'c.ts')
    assert.ok(state.max >= 2, `并发未生效 max=${state.max}`)
  })
})

test('并发上限生效：超上限排队不丢弃', async () => {
  const state = { current: 0, max: 0, total: 0 }
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': {
      invoke: async (bag) => {
        state.current += 1
        state.total += 1
        state.max = Math.max(state.max, state.current)
        await sleep(15)
        state.current -= 1
        return { ok: true, result: { path: bag.args.path } }
      },
    },
  }
  const calls = Array.from({ length: 6 }, (_, index) => ({ call_id: `c${index}`, tool: 'read', args: { path: `${index}.ts` } }))
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', { calls, directory: directory([READ]), workspace_root: '/ws', concurrency: 2 })
    assert.equal(response.value.results.length, 6)
    assert.equal(state.total, 6)
    assert.ok(state.max <= 2, `并发超上限 max=${state.max}`)
  })
})

test('绑定项派发为反向 port.call（args 扁平化）', async () => {
  const providers = {
    guard: { judge: guardAllow },
    retrieval: { search: (args) => ({ ok: true, kind: 'search', hits: [], echo: args.query }) },
  }
  const binding = decl('retrieval', {
    provider: 'retrieval',
    kind: 'binding',
    method: 'search',
    argsSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: true },
    caps: NO_CAPS,
    idempotent: true,
  })
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'retrieval', args: { query: '记忆' } }],
      directory: directory([binding]),
    })
    const result = response.value.results[0]
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.result.kind, 'search')
    assert.equal(result.result.echo, '记忆')
    const call = service.portCalls.find((item) => item.port === 'retrieval' && item.method === 'search')
    assert.ok(call, '应发 retrieval.search 反向调用')
    assert.equal(call.args.query, '记忆')
  })
})

test('record 绑定派发为反向 port.call（evolve-metrics.record），写类不缓存', async () => {
  let invoked = 0
  const providers = {
    guard: { judge: guardAllow },
    'evolve-metrics': {
      record: (args) => {
        invoked += 1
        return { evidence_id: 'ev-1', workspace_id: args.workspace_id, source: args.user_message_def }
      },
    },
  }
  await withService(providers, async (service) => {
    // user_message_def / workspace_id 由调用方在派发时注入（随 bag 透传），模型空参调用即可。
    const bag = {
      calls: [{ call_id: 'c1', tool: 'record', args: {} }],
      tools_bindings: { record: recordBinding() },
      user_message_def: { def: 'h1' },
      workspace_id: 'w1',
    }
    const response = await service.call('dispatch', bag)
    assert.equal(response.kind, 'result', JSON.stringify(response))
    const result = response.value.results[0]
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.result.evidence_id, 'ev-1')
    assert.equal(result.result.workspace_id, 'w1')
    assert.equal(result.result.source.def, 'h1')

    const reverse = service.portCalls.find((item) => item.port === 'evolve-metrics' && item.method === 'record')
    assert.ok(reverse, '应发 evolve-metrics.record 反向调用')
    assert.equal(reverse.args.user_message_def.def, 'h1')
    assert.equal(reverse.args.workspace_id, 'w1')
    assert.equal(reverse.args.caps.net, 'none')

    // idempotent:false → 同参不命中缓存，重复派发再次调用
    await service.call('dispatch', bag)
    assert.equal(invoked, 2)
  })
})

test('绑定 method 缺省 = 投影读（不调提供者）', async () => {
  let delivered = 0
  const providers = {
    guard: { judge: guardAllow },
    session: { deliver: () => { delivered += 1; return { ok: true } } },
  }
  const binding = decl('subagent.status', {
    provider: 'session',
    kind: 'binding',
    method: null,
    argsSchema: { type: 'object', additionalProperties: true },
    caps: NO_CAPS,
    idempotent: true,
  })
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'subagent.status', args: {} }],
      directory: directory([binding]),
      projection_reads: { 'subagent.status': { thread: 't-9', status: 'running' } },
    })
    assert.equal(response.value.results[0].result.thread, 't-9')
    assert.equal(delivered, 0)
    assert.equal(service.portCalls.some((item) => item.port === 'session'), false)
  })
})

test('escalate：只回 needs_approval 标记、不入队、不调提供者', async () => {
  let invoked = 0
  const providers = {
    guard: { judge: guardByTool({ read: 'escalate' }) },
    'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(response.value.results[0].ok, false)
    assert.equal(response.value.results[0].error.code, 'needs_approval')
    assert.equal(invoked, 0)
  })
})

test('deny：回 denied、零副作用、不调提供者', async () => {
  let invoked = 0
  const providers = {
    guard: { judge: guardByTool({ read: 'deny' }) },
    'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(response.value.results[0].error.code, 'denied')
    assert.equal(invoked, 0)
  })
})

test('批级取最严：同批 any escalate → 整批 needs_approval（不部分放行）', async () => {
  let invoked = 0
  const providers = {
    guard: { judge: guardByTool({ edit: 'escalate' }) },
    'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [
        { call_id: 'c1', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'c2', tool: 'edit', args: { path: 'x.ts' } },
      ],
      directory: directory([READ, EDIT]),
      workspace_root: '/ws',
    })
    assert.deepEqual(response.value.results.map((item) => item.error.code), ['needs_approval', 'needs_approval'])
    assert.equal(invoked, 0)
  })
})

test('workspace_missing 只对相对路径拒：绝对路径仍可派发', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: (bag) => ({ ok: true, result: { path: bag.args.path } }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
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

test('错误原样透传：提供者错误码不改写（含 timeout），port.call 失败同样透传', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-shell': { invoke: () => ({ ok: false, error: { code: 'timeout', message: 'sandbox timeout' } }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [
        { call_id: 'c1', tool: 'shell', args: { input: 'sleep 1' } },
        { call_id: 'c2', tool: 'read', args: { path: 'x.ts' } },
      ],
      directory: directory([SHELL, READ]),
      workspace_root: '/ws',
    })
    const byId = new Map(response.value.results.map((item) => [item.call_id, item]))
    assert.equal(byId.get('c1').error.code, 'timeout')
    assert.equal(byId.get('c1').error.message, 'sandbox timeout')
    // read 的 provider 未注入 → port.call 失败 unresolved_cap 原样透传
    assert.equal(byId.get('c2').error.code, 'unresolved_cap')
  })
})

test('结果缓存：幂等工具命中、写类不缓存', async () => {
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
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [
        { call_id: 'r1', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'r2', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'e1', tool: 'edit', args: { path: 'x.ts' } },
        { call_id: 'e2', tool: 'edit', args: { path: 'x.ts' } },
      ],
      directory: directory([READ, EDIT]),
      workspace_root: '/ws',
    })
    assert.equal(response.value.results.length, 4)
    assert.equal(counts.read, 1, '幂等工具应命中缓存')
    assert.equal(counts.edit, 2, '写类工具不应缓存')
  })
})

test('bag.cache=false 关闭缓存', async () => {
  let invoked = 0
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
  }
  await withService(providers, async (service) => {
    await service.call('dispatch', {
      calls: [
        { call_id: 'r1', tool: 'read', args: { path: 'x.ts' } },
        { call_id: 'r2', tool: 'read', args: { path: 'x.ts' } },
      ],
      directory: directory([READ]),
      workspace_root: '/ws',
      cache: false,
    })
    assert.equal(invoked, 2)
  })
})

test('bag.verdicts 已给则跳过 guard 兜底、直接消费', async () => {
  let guardCalls = 0
  let invoked = 0
  const providers = {
    guard: { judge: () => { guardCalls += 1; return guardAllow({ calls: [] }) } },
    'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
      verdicts: [{ call_id: 'c1', verdict: 'allow' }],
    })
    assert.equal(response.value.results[0].ok, true)
    assert.equal(guardCalls, 0)
    assert.equal(invoked, 1)
  })
})

test('bag.verdicts 接受字符串数组 / call_id 映射，均跳过 guard', async () => {
  let guardCalls = 0
  let invoked = 0
  const providers = {
    guard: { judge: () => { guardCalls += 1; return guardAllow({ calls: [] }) } },
    'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } },
  }
  await withService(providers, async (service) => {
    const denied = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
      verdicts: ['deny'],
    })
    assert.equal(denied.value.results[0].error.code, 'denied')
    const allowed = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'y.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
      verdicts: { c1: 'allow' },
    })
    assert.equal(allowed.value.results[0].ok, true)
    assert.equal(guardCalls, 0)
    assert.equal(invoked, 1)
  })
})

test('bag.verdicts=deny 时零副作用', async () => {
  let invoked = 0
  const providers = { 'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } } }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
      verdicts: { decisions: [{ index: 0, verdict: 'deny' }] },
    })
    assert.equal(response.value.results[0].error.code, 'denied')
    assert.equal(invoked, 0)
  })
})

test('caps / grant / tier 透传给提供者；caps 以工具声明为准', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-shell': { invoke: (bag) => ({ ok: true, result: { caps: bag.caps, grant: bag.grant, tier: bag.tier, root: bag.workspace_root } }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
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

test('MCP 工具经同一目录派发到 mcp.invoke', async () => {
  const providers = {
    guard: { judge: guardAllow },
    mcp: { invoke: (bag) => ({ ok: true, result: { tool: bag.tool, args: bag.args } }) },
  }
  const mcpTool = decl('mcp.srv.echo', {
    provider: 'mcp',
    kind: 'invoke',
    argsSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
    caps: NO_CAPS,
    idempotent: false,
  })
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'mcp.srv.echo', args: { text: 'hi' } }],
      directory: directory([mcpTool]),
    })
    assert.equal(response.value.results[0].result.tool, 'mcp.srv.echo')
    const call = service.portCalls.find((item) => item.port === 'mcp' && item.method === 'invoke')
    assert.equal(call.args.tool, 'mcp.srv.echo')
    assert.equal(call.args.args.text, 'hi')
  })
})

test('unknown_tool / bad_args / bad_tool_decl', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: () => ({ ok: true, result: {} }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [
        { call_id: 'u', tool: 'nope', args: {} },
        { call_id: 'a', tool: 'read', args: {} },
        { call_id: 'd', tool: 'broken', args: {} },
      ],
      directory: directory([READ], [{ name: 'broken', code: 'bad_tool_decl', message: 'missing boundaries' }]),
      workspace_root: '/ws',
    })
    const byId = new Map(response.value.results.map((item) => [item.call_id, item]))
    assert.equal(byId.get('u').error.code, 'unknown_tool')
    assert.equal(byId.get('a').error.code, 'bad_args')
    assert.equal(byId.get('d').error.code, 'bad_tool_decl')
  })
})

test('派发时发 tool.start / tool.end 事件（带 call_id）', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': { invoke: () => ({ ok: true, result: {} }) },
  }
  await withService(providers, async (service) => {
    await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    const start = service.events.find((event) => event.topic === 'tool.start')
    const end = service.events.find((event) => event.topic === 'tool.end')
    assert.equal(start.payload.call_id, 'c1')
    assert.equal(start.payload.tool, 'read')
    assert.equal(end.payload.call_id, 'c1')
    assert.equal(end.payload.ok, true)
  })
})

test('dispatch 无 directory 时现场拉 describe 构造目录', async () => {
  const providers = {
    guard: { judge: guardAllow },
    'tool-fs': {
      describe: () => ({ tools: [READ] }),
      invoke: (bag) => ({ ok: true, result: { path: bag.args.path } }),
    },
  }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      workspace_root: '/ws',
    })
    assert.equal(response.value.results[0].ok, true)
    assert.ok(service.portCalls.some((item) => item.port === 'tool-fs' && item.method === 'describe'))
  })
})

test('guard 不可用 → fail-closed 全拒', async () => {
  let invoked = 0
  const providers = { 'tool-fs': { invoke: () => { invoked += 1; return { ok: true, result: {} } } } }
  await withService(providers, async (service) => {
    const response = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'read', args: { path: 'x.ts' } }],
      directory: directory([READ]),
      workspace_root: '/ws',
    })
    assert.equal(response.value.results[0].error.code, 'denied')
    assert.equal(invoked, 0)
  })
})
