// 目录构造测试：并集（describe 提供者 + 绑定表 + 外部 MCP）、四要素拒、argsSchema 白名单、
// caps 字符串 net 校验、工具名全局唯一、描述拼装。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startService, toolDecl, bindingItem, recordBinding } from './driver.mjs'

async function withService(providers, fn) {
  const service = startService({ providers })
  try {
    const manifest = await service.hello()
    assert.equal(manifest.kind, 'manifest')
    return await fn(service)
  } finally {
    service.close()
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
          argsSchema: { type: 'object', properties: { conversation_id: { type: 'string' } }, required: ['conversation_id'] },
          caps: { fs: { read: 'none', write: 'none' }, net: 'none' },
          idempotent: true,
        }),
      ],
    }),
  },
}

test('list 并集：describe 提供者 + 绑定表 + 外部 MCP 工具', async () => {
  await withService(BASE_PROVIDERS, async (service) => {
    const response = await service.call('list', {
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
    assert.equal(response.kind, 'result', JSON.stringify(response))
    const names = response.value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['mcp.srv.echo', 'read', 'retrieval', 'todo.read'])

    const byName = new Map(response.value.tools.map((tool) => [tool.name, tool]))
    assert.equal(byName.get('read').provider, 'tool-fs')
    assert.equal(byName.get('read').kind, 'invoke')
    assert.equal(byName.get('retrieval').provider, 'retrieval')
    assert.equal(byName.get('retrieval').kind, 'binding')
    assert.equal(byName.get('retrieval').method, 'search')
    assert.equal(byName.get('mcp.srv.echo').provider, 'mcp')
    // caps 归一：布尔 false → "none"
    assert.equal(byName.get('mcp.srv.echo').caps.net, 'none')
  })
})

test('list：record 绑定（#44 evolve-metrics）随 pins 就位进入目录', async () => {
  await withService(BASE_PROVIDERS, async (service) => {
    const response = await service.call('list', { tools_bindings: { record: recordBinding() } })
    assert.equal(response.kind, 'result', JSON.stringify(response))
    const tool = response.value.tools.find((item) => item.name === 'record')
    assert.ok(tool, 'record 应进目录')
    assert.equal(tool.provider, 'evolve-metrics')
    assert.equal(tool.kind, 'binding')
    assert.equal(tool.method, 'record')
    assert.equal(tool.idempotent, false)
    assert.equal(tool.caps.net, 'none')
    assert.equal(tool.caps.fs.read, 'none')
    assert.deepEqual(Object.keys(tool.argsSchema.properties).sort(), ['user_message_def', 'workspace_id'])
    assert.equal(tool.argsSchema.required, undefined, '注入参数不设 required，模型可空参调用')
    assert.deepEqual(tool.render, { form: 'card', label: 'record', summary: 'record  {result.evidence_id}', tone: 'plain', detail: { kind: 'json' } })
    assert.equal(response.value.rejected.length, 0)
  })
})

test('list：description 缺省由四要素拼装', async () => {
  const providers = {
    'tool-fs': { describe: () => ({ tools: [toolDecl({ description: undefined })] }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    const tool = response.value.tools.find((item) => item.name === 'read')
    assert.ok(tool.description.includes('读取一个文本文件'))
    assert.ok(tool.description.includes('使用时机'))
    assert.ok(tool.description.includes('边界'))
  })
})

test('四要素缺一即 bad_tool_decl（不进目录、rejected 留诊断）', async () => {
  const providers = {
    'tool-fs': {
      describe: () => ({ tools: [toolDecl({ boundaries: undefined }), toolDecl({ name: 'glob' })] }),
    },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    const names = response.value.tools.map((tool) => tool.name)
    assert.deepEqual(names, ['glob'])
    assert.equal(response.value.rejected[0].name, 'read')
    assert.equal(response.value.rejected[0].code, 'bad_tool_decl')
    assert.match(response.value.rejected[0].message, /boundaries/)
  })
})

test('param_semantics 未覆盖必填参数 → bad_tool_decl', async () => {
  const providers = {
    'tool-fs': { describe: () => ({ tools: [toolDecl({ param_semantics: {} })] }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    assert.equal(response.value.tools.length, 0)
    assert.match(response.value.rejected[0].message, /param_semantics/)
  })
})

test('argsSchema 白名单外关键词 → bad_tool_decl', async () => {
  const providers = {
    'tool-fs': {
      describe: () => ({
        tools: [toolDecl({ argsSchema: { type: 'object', properties: { path: { type: 'string', pattern: '^x' } } } })],
      }),
    },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    assert.equal(response.value.tools.length, 0)
    assert.match(response.value.rejected[0].message, /pattern/)
  })
})

test('caps：net 布尔 true 拒、false 归一 none、非法字符串拒', async () => {
  const providers = {
    'tool-fs': {
      describe: () => ({
        tools: [
          toolDecl({ name: 'a', caps: { fs: { read: 'none', write: 'none' }, net: true } }),
          toolDecl({ name: 'b', caps: { fs: { read: 'none', write: 'none' }, net: false } }),
          toolDecl({ name: 'c', caps: { fs: { read: 'none', write: 'none' }, net: 'sometimes' } }),
          toolDecl({ name: 'd', caps: { fs: { read: 'none', write: 'none' }, net: 'limited' } }),
        ],
      }),
    },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    const names = response.value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['b', 'd'])
    const b = response.value.tools.find((tool) => tool.name === 'b')
    assert.equal(b.caps.net, 'none')
    const d = response.value.tools.find((tool) => tool.name === 'd')
    assert.equal(d.caps.net, 'limited')
    assert.equal(response.value.rejected.length, 2)
  })
})

test('工具名全局唯一：跨来源重名后者被拒', async () => {
  const providers = {
    'tool-fs': { describe: () => ({ tools: [toolDecl({ name: 'retrieval' })] }) },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', { tools_bindings: { retrieval: bindingItem() } })
    const names = response.value.tools.map((tool) => tool.name)
    assert.deepEqual(names, ['retrieval'])
    assert.equal(response.value.tools[0].provider, 'tool-fs')
    assert.equal(response.value.rejected[0].code, 'bad_tool_decl')
    assert.match(response.value.rejected[0].message, /duplicate/)
  })
})

test('绑定 class 未 pin → bad_tool_decl', async () => {
  await withService(BASE_PROVIDERS, async (service) => {
    const response = await service.call('list', { tools_bindings: { ghost: bindingItem({ class: 'ghost' }) } })
    assert.equal(response.value.tools.some((tool) => tool.name === 'ghost'), false)
    assert.match(response.value.rejected[0].message, /not pinned/)
  })
})

test('绑定 method 缺省 = 投影读（method null）', async () => {
  await withService(BASE_PROVIDERS, async (service) => {
    const response = await service.call('list', {
      tools_bindings: {
        'subagent.status': bindingItem({ class: 'session', method: null, argsSchema: { type: 'object' }, param_semantics: {} }),
      },
    })
    const tool = response.value.tools.find((item) => item.name === 'subagent.status')
    assert.equal(tool.kind, 'binding')
    assert.equal(tool.method, null)
  })
})

test('describe 提供者不可用只跳过，不阻断目录', async () => {
  await withService({ 'tool-fs': { describe: () => ({ tools: [toolDecl()] }) } }, async (service) => {
    const response = await service.call('list', {})
    assert.deepEqual(response.value.tools.map((tool) => tool.name), ['read'])
    assert.equal(response.value.rejected.length, 0)
  })
})

test('管理面工具（net:false 旧形）经目录校验通过，render 原样保留', async () => {
  const pluginTool = toolDecl({
    name: 'plugin.write',
    intent: '为候选插件源码产出世界写计划。',
    when_to_use: '候选包已通过 plugin.validate 时。',
    param_semantics: { identity: '目标身份名。', files: '候选源码树。' },
    boundaries: '只产写计划，不落账、不审批。',
    argsSchema: {
      type: 'object',
      properties: { identity: { type: 'string' }, files: { type: 'object' } },
      required: ['identity', 'files'],
      additionalProperties: true,
    },
    caps: { fs: { read: 'none', write: 'none' }, net: false, timeout_ms: 30000, mem_mb: 256, output_max: 2097152, procs_max: 1 },
    idempotent: false,
    render: { form: 'card', label: 'plugin', summary: 'write  {identity}', tone: 'solid', detail: { kind: 'diff' } },
  })
  const providers = {
    'plugin-admin': { describe: () => ({ tools: [pluginTool] }) },
    'orchestration-admin': {
      describe: () => ({
        tools: [
          toolDecl({
            name: 'orchestration.propose',
            param_semantics: { class: '变更类。', evidence_ids: '证据 id。', graph: '候选图。' },
            argsSchema: {
              type: 'object',
              properties: { class: { enum: ['binding', 'structure'] }, evidence_ids: { type: 'array', items: { type: 'string' } }, graph: { type: 'object' } },
              required: ['class', 'evidence_ids', 'graph'],
              additionalProperties: true,
            },
            caps: { fs: { read: 'none', write: 'none' }, net: false },
            idempotent: false,
            render: { form: 'card', label: 'orchestration', summary: 'propose  {target}', tone: 'solid', detail: { kind: 'diff' } },
          }),
        ],
      }),
    },
  }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    const names = response.value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['orchestration.propose', 'plugin.write'])
    const pluginWrite = response.value.tools.find((tool) => tool.name === 'plugin.write')
    assert.equal(pluginWrite.caps.net, 'none')
    assert.deepEqual(pluginWrite.render, { form: 'card', label: 'plugin', summary: 'write  {identity}', tone: 'solid', detail: { kind: 'diff' } })
  })
})

test('无 render 描述符的工具照常进目录（渲染端降级 markdown）', async () => {
  const providers = { 'tool-fs': { describe: () => ({ tools: [toolDecl({ name: 'plain', render: undefined })] }) } }
  await withService(providers, async (service) => {
    const response = await service.call('list', {})
    const tool = response.value.tools.find((item) => item.name === 'plain')
    assert.ok(tool)
    assert.equal(Object.hasOwn(tool, 'render'), false)
  })
})
