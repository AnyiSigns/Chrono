// `tool-registry` 协议级测试（node --test）：list 并集（describe + 绑定 + MCP）、四要素 / schema / caps 拒、
// 工具名去重、描述拼装与注入参数摘除、复用已装配目录不再拉 describe。
// 反向桥：`tool-schema.*` spawn 其真实服务进程应答，describe 用注入的假提供者。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { relayFrame, serviceEntry, startBridgedService } from './bridge.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENTRY = join(PKG_ROOT, 'execute', 'main.ts')
const SCHEMA_ROOT = resolve(PKG_ROOT, '..', 'tool-schema')
const FIXTURE_ROOT = resolve(PKG_ROOT, '..', '..', 'tests', 'fixtures', 'plugins', 'tool-fixture')

const PINS = {
  'tool-schema': 'tool-schema',
  session: 'session',
  compress: 'compress',
  memory: 'memory-store',
  retrieval: 'memory-retrieval',
  'memory-maintenance': 'memory-consolidate',
  'evolve-metrics': 'evolve-metrics',
}

/** 扩展类 `tool-provider` 的世界成员（宿主按世界能力索引注入；提供方身份名，码元序）。 */
const MANY_NEEDS = {
  'tool-provider': [
    'mcp',
    'orchestration-admin',
    'plugin-admin',
    'question',
    'todo',
    'tool-browser',
    'tool-fs',
    'tool-http',
    'tool-shell',
  ],
}

function start(providers = {}, options = {}) {
  const schema = startBridgedService({
    cwd: SCHEMA_ROOT,
    entry: serviceEntry(SCHEMA_ROOT),
    timeoutMs: 15000,
  })
  const extra = options.services ?? {}
  const manyNeeds = { ...MANY_NEEDS, ...(options.manyNeeds ?? {}) }
  const registry = startBridgedService({
    cwd: PKG_ROOT,
    entry: ENTRY,
    timeoutMs: 15000,
    env: {
      CHRONO_PLUGIN_PINS: JSON.stringify(PINS),
      CHRONO_PLUGIN_MANY_NEEDS: JSON.stringify(manyNeeds),
    },
    async onPortCall(message) {
      if (message.port === 'tool-schema') {
        return relayFrame(
          await schema.call('tool-schema', message.method, message.args ?? {}, message.env),
        )
      }
      // 按成员定位的 many：帧 `provider` = 目标提供方身份名；否则为单值端口。
      const dest = typeof message.provider === 'string' ? message.provider : message.port
      const fn = providers[dest]?.describe
      if (typeof fn === 'function') return { ok: true, value: await fn(message.args) }
      const service = extra[dest]
      if (service !== undefined) {
        return relayFrame(
          await service.call(message.port, message.method, message.args ?? {}, message.env),
        )
      }
      return { ok: false, code: 'unresolved_cap', message: `no provider ${String(dest)}` }
    },
  })
  return {
    ...registry,
    exit: Promise.all([registry.exit, schema.exit]).then(([code]) => code),
    close() {
      registry.close()
      schema.close()
      for (const service of Object.values(extra)) service.close()
    },
  }
}

async function withService(providers, fn, options = {}) {
  const drv = start(providers, options)
  try {
    await drv.hello('tool-registry')
    return await fn(drv)
  } finally {
    drv.close()
    await drv.exit
  }
}

async function listValue(drv, args) {
  const message = await drv.call('tool-registry', 'list', args)
  assert.equal(message.kind, 'result', JSON.stringify(message))
  return message.value
}

function toolDecl(overrides = {}) {
  return {
    name: 'read',
    intent: '读取一个文本文件的内容。',
    when_to_use: '需要查看文件内容时。',
    param_semantics: { path: '文件路径。' },
    boundaries: '只读单文件；找文件用 glob。',
    description: '读文本文件；返回 {text}。',
    argsSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    },
    caps: { fs: { read: 'workspace', write: 'none' }, net: 'none' },
    idempotent: false,
    render: { form: 'line', label: 'read', summary: '{path}' },
    ...overrides,
  }
}

function bindingItem(overrides = {}) {
  return {
    class: 'retrieval',
    method: 'search',
    intent: '检索长期记忆。',
    when_to_use: '需要语义召回记忆时。',
    param_semantics: { query: '检索词。' },
    boundaries: '只读检索；写入用 memory。',
    argsSchema: {
      type: 'object',
      properties: { query: { type: 'string', minLength: 1 } },
      required: ['query'],
      additionalProperties: true,
    },
    caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
    idempotent: true,
    ...overrides,
  }
}

const BASE_PROVIDERS = {
  'tool-fs': { describe: () => ({ tools: [toolDecl()] }) },
  todo: {
    describe: () => ({
      tools: [
        toolDecl({
          name: 'todo.read',
          param_semantics: { conversation_id: '会话 id。' },
          argsSchema: {
            type: 'object',
            properties: { conversation_id: { type: 'string' } },
            required: ['conversation_id'],
          },
          caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
          idempotent: true,
        }),
      ],
    }),
  },
}

test('hello 回 manifest：能力类与 list 声明与 plugin.json 一致', async () => {
  await withService({}, async (drv) => {
    const manifest = await drv.request('hello', { impl: 'tool-registry' }, 'manifest')
    assert.equal(manifest.identity, 'tool-registry')
    assert.deepEqual(manifest.methods['tool-registry'], ['list'])
  })
})

test('list 并集：describe 提供者 + 绑定表 + 外部 MCP 工具', async () => {
  await withService(BASE_PROVIDERS, async (drv) => {
    const value = await listValue(drv, {
      tools_bindings: { retrieval: bindingItem() },
      mcp_tools: [
        {
          name: 'mcp.srv.echo',
          intent: '外部回声',
          when_to_use: '需要回声时',
          param_semantics: { text: '文本' },
          boundaries: '外部工具',
          argsSchema: { type: 'object', properties: { text: { type: 'string' } } },
          caps: { fs: { read: 'none', write: 'none' }, net: false },
          idempotent: false,
        },
      ],
    })
    const names = value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['mcp.srv.echo', 'read', 'retrieval', 'todo.read'])
    const byName = new Map(value.tools.map((tool) => [tool.name, tool]))
    assert.equal(byName.get('read').provider, 'tool-fs')
    assert.equal(byName.get('read').kind, 'invoke')
    assert.equal(byName.get('retrieval').kind, 'binding')
    assert.equal(byName.get('retrieval').method, 'search')
    assert.equal(byName.get('mcp.srv.echo').provider, 'mcp')
    assert.equal(byName.get('mcp.srv.echo').caps.net, 'none')
  })
})

test('tool-schema 是校验依赖、不被当作 describe 提供者探测', async () => {
  await withService(BASE_PROVIDERS, async (drv) => {
    await listValue(drv, {})
    assert.equal(
      drv.portCalls.some((frame) => frame.port === 'tool-schema' && frame.method === 'describe'),
      false,
    )
    assert.ok(
      drv.portCalls.some(
        (frame) => frame.port === 'tool-schema' && frame.method === 'normalize-decl',
      ),
    )
  })
})

test('list：description 由四要素拼装；param_semantics 并入 argsSchema 不重复', async () => {
  await withService(BASE_PROVIDERS, async (drv) => {
    const value = await listValue(drv, {})
    const tool = value.tools.find((item) => item.name === 'read')
    assert.ok(tool.description.startsWith('读文本文件'), tool.description)
    assert.ok(tool.description.includes('使用时机：需要查看文件内容时。'), tool.description)
    assert.ok(tool.description.includes('边界：只读单文件；找文件用 glob。'), tool.description)
    assert.ok(
      !tool.description.includes('参数：'),
      `参数说明应内联进 argsSchema：${tool.description}`,
    )
    assert.equal(tool.argsSchema.properties.path.description, '文件路径。')
  })
})

test('list：hidden_params 从模型可见 argsSchema 摘掉，validateSchema 保留注入参数', async () => {
  const providers = {
    'tool-fs': {
      describe: () => ({
        tools: [
          toolDecl({
            name: 'probe',
            param_semantics: { path: '文件路径。', workspace: '工作区 id（调用方注入）。' },
            hidden_params: ['workspace'],
            argsSchema: {
              type: 'object',
              required: ['path', 'workspace'],
              properties: { path: { type: 'string' }, workspace: { type: 'string' } },
              additionalProperties: false,
            },
          }),
        ],
      }),
    },
  }
  await withService(providers, async (drv) => {
    const value = await listValue(drv, {})
    const tool = value.tools.find((item) => item.name === 'probe')
    assert.deepEqual(Object.keys(tool.argsSchema.properties), ['path'])
    assert.deepEqual(tool.argsSchema.required, ['path'])
    assert.ok(tool.validateSchema.properties.workspace, '校验 schema 须保留注入参数')
    assert.ok(!tool.description.includes('workspace'))
  })
})

test('不合规声明逐项拒：四要素 / 白名单 / caps / 去重 / 未 pin 绑定', async () => {
  const providers = {
    'tool-fs': {
      describe: () => ({
        tools: [
          toolDecl({ boundaries: undefined }),
          toolDecl({ name: 'glob' }),
          toolDecl({
            name: 'patterned',
            argsSchema: { type: 'object', properties: { p: { type: 'string', pattern: '^x' } } },
          }),
          toolDecl({ name: 'nettrue', caps: { fs: { read: 'none', write: 'none' }, net: true } }),
        ],
      }),
    },
    todo: { describe: () => ({ tools: [toolDecl({ name: 'glob' })] }) },
  }
  await withService(providers, async (drv) => {
    const value = await listValue(drv, {
      tools_bindings: { ghost: bindingItem({ class: 'ghost' }) },
    })
    assert.deepEqual(
      value.tools.map((tool) => tool.name),
      ['glob'],
    )
    const codes = value.rejected.map((item) => item.code)
    assert.ok(codes.every((code) => code === 'bad_tool_decl'))
    assert.ok(value.rejected.some((item) => /boundaries/.test(item.message)))
    assert.ok(value.rejected.some((item) => /pattern/.test(item.message)))
    assert.ok(value.rejected.some((item) => /caps\.net/.test(item.message)))
    assert.ok(value.rejected.some((item) => /duplicate/.test(item.message)))
    assert.ok(value.rejected.some((item) => /not pinned/.test(item.message)))
  })
})

test('绑定 method 缺省 = 投影读（method null）', async () => {
  await withService(BASE_PROVIDERS, async (drv) => {
    const value = await listValue(drv, {
      tools_bindings: {
        'subagent.status': bindingItem({
          class: 'session',
          method: null,
          argsSchema: { type: 'object' },
          param_semantics: {},
        }),
      },
    })
    const tool = value.tools.find((item) => item.name === 'subagent.status')
    assert.equal(tool.kind, 'binding')
    assert.equal(tool.method, null)
  })
})

test('复用 bag.directory：不再拉 describe、不再重复校验', async () => {
  await withService(BASE_PROVIDERS, async (drv) => {
    const assembled = await listValue(drv, {})
    const before = drv.portCalls.filter((frame) => frame.method === 'describe').length
    const reused = await listValue(drv, { directory: assembled })
    assert.deepEqual(
      reused.tools.map((tool) => tool.name).sort(),
      assembled.tools.map((tool) => tool.name).sort(),
    )
    const after = drv.portCalls.filter((frame) => frame.method === 'describe').length
    assert.equal(after, before, '复用目录不得再拉 describe')
  })
})

test('坏 args：bag 非对象 → bad_args', async () => {
  await withService({}, async (drv) => {
    const bad = await drv.call('tool-registry', 'list', [1, 2])
    assert.equal(bad.kind, 'error')
    assert.equal(bad.code, 'bad_args')
  })
})

test('零改动：新工具插件（fixture implements tool-provider）随世界成员表自动进目录', async () => {
  const fixture = startBridgedService({
    cwd: FIXTURE_ROOT,
    entry: join(FIXTURE_ROOT, 'execute', 'main.mjs'),
    timeoutMs: 15000,
  })
  try {
    // 新增提供方 = 世界成员表多一项；tool-registry / list 代码与声明均不改。
    await withService(
      BASE_PROVIDERS,
      async (drv) => {
        const value = await listValue(drv, {})
        const names = value.tools.map((tool) => tool.name)
        assert.ok(names.includes('fixture.echo'), `目录应含 fixture.echo：${JSON.stringify(names)}`)
        const tool = value.tools.find((item) => item.name === 'fixture.echo')
        assert.equal(tool.provider, 'tool-fixture')
        assert.equal(tool.kind, 'invoke')
      },
      {
        services: { 'tool-fixture': fixture },
        manyNeeds: {
          'tool-provider': [...MANY_NEEDS['tool-provider'], 'tool-fixture'],
        },
      },
    )
  } finally {
    fixture.close()
  }
})
