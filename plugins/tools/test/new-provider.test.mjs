// 扩展点零改动证明：新增一个工具插件（夹具 `tool-fixture`，`implements:["tool-provider"]`）后，
// `tools` → `tool-registry` → `tool-dispatch` 链路代码与声明均不改：
//   1) `tools.list` 自动把它纳入目录；
//   2) `tools.dispatch` 自动按成员定位调用它的 `invoke`。
// 成员表由宿主按世界能力索引注入（测试以 `manyNeeds` 模拟一次世界变更）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { startService, toolDecl } from './driver.mjs'
import { startBridgedService } from './bridge.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_ROOT = resolve(HERE, '..', '..', '..', 'tests', 'fixtures', 'plugins', 'tool-fixture')
const FIXTURE_ENTRY = join(FIXTURE_ROOT, 'execute', 'main.mjs')

test('零改动：新工具插件随世界成员表自动进目录并可派发', async () => {
  const fixture = startBridgedService({
    cwd: FIXTURE_ROOT,
    entry: FIXTURE_ENTRY,
    timeoutMs: 15000,
  })
  const service = startService({
    providers: {
      'tool-fs': { describe: () => ({ tools: [toolDecl()] }) },
    },
    services: { 'tool-fixture': fixture },
    manyNeeds: {
      'tool-provider': ['tool-fixture', 'tool-fs'],
    },
  })
  try {
    await service.hello()
    const listed = await service.call('list', {})
    assert.equal(listed.kind, 'result', JSON.stringify(listed))
    const names = listed.value.tools.map((tool) => tool.name).sort()
    assert.deepEqual(names, ['fixture.echo', 'read'])
    const fixtureTool = listed.value.tools.find((tool) => tool.name === 'fixture.echo')
    assert.equal(fixtureTool.provider, 'tool-fixture')
    assert.equal(fixtureTool.kind, 'invoke')

    // 派发：无 directory 时下游现场拉目录，再经 `tool-provider` 按成员定位 invoke。
    const dispatched = await service.call('dispatch', {
      calls: [{ call_id: 'c1', tool: 'fixture.echo', args: { text: 'hi' } }],
      verdicts: 'allow',
    })
    assert.equal(dispatched.kind, 'result', JSON.stringify(dispatched))
    const result = dispatched.value.results[0]
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.result.echoed, { text: 'hi' })
  } finally {
    service.close()
    await service.exit
  }
})
