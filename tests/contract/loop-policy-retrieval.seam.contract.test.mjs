// 接缝契约 9：loop-policy ↔ retrieval（跨语言：TS 发、Rust 收）。
// 共享真源：chain-contract/schema/retrieval-search.schema.json（语言中立）+ fixtures/retrieval-search.json（authoritative）。
//
// 消费向（TS sends）：真实 loop-policy 发出 `retrieval.search` bag，键名逐字节对齐权威键
//   （`workspace` / `recall_budget` / `query`），且不再出现旧键 `workspace_id` / `budget`；
//   发出的 bag 并经生成的契约校验器 `validateRetrievalSearchBag` 通过。
// 供给向（Rust receives）：消费方 memory-retrieval 的实际解析代码（src/bag.rs / src/config.rs）
//   与 schema/retrieval.json 读的是同一组权威键——没有可启动的 `execute/main.ts` 入口，
//   跨语言一致性以「生产方输出 == 消费方实际读取的键」双向断言。schema 本身亦逐键断言。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { retrievalSearch } from '../../chain-contract/fixtures/index.ts'
import { RETRIEVAL_SEARCH_KEYS, validateRetrievalSearchBag } from '../../plugins/loop-policy/execute/contract/index.ts'
import { startService, defaultProviders } from '../../plugins/loop-policy/test/driver.mjs'
import { REPO_ROOT } from './_bridge.mjs'

/** 最小图：recall 为入口（无入边即无条件激活），唯一入边把召回产出送 sink 收口。 */
const RECALL_GRAPH = {
  nodes: ['recall', 'turn.commit'],
  edges: [{ from: [0, 'recall'], to: [1, 'results'] }],
  entry_supply: [{ type_id: 'task', role: 'task' }],
  loop: { when: '' },
  sink: 1,
}

/** 驱动真实 loop-policy 走 recall 节点，返回其发出的 `retrieval.search` bag。 */
async function produceSearchBag() {
  let captured = null
  const service = startService({
    providers: {
      ...defaultProviders({
        'retrieval.search': (args) => {
          captured = args
          return { items: [] }
        },
      }),
    },
  })
  try {
    const result = await service.interpret({
      task: retrievalSearch.authoritative.query,
      workspace_id: retrievalSearch.authoritative.workspace,
      budget: retrievalSearch.authoritative.recall_budget,
      graph: { graph: RECALL_GRAPH },
    })
    assert.equal(result.kind, 'result', JSON.stringify(result))
    assert.ok(captured !== null, 'recall 节点须派发 retrieval.search')
    return captured
  } finally {
    service.close()
  }
}

function readRepo(rel) {
  return readFileSync(join(REPO_ROOT, rel), 'utf8')
}

test('消费向：TS 发出的 retrieval.search bag 用权威键 workspace / recall_budget / query', async () => {
  const bag = await produceSearchBag()
  assert.deepEqual(Object.keys(bag).sort(), ['query', 'recall_budget', 'workspace'])
  assert.equal(bag.query, retrievalSearch.authoritative.query)
  assert.equal(bag.workspace, retrievalSearch.authoritative.workspace)
  assert.equal(bag.recall_budget, retrievalSearch.authoritative.recall_budget)
  assert.equal('workspace_id' in bag, false, '旧键 workspace_id 不得再发出')
  assert.equal('budget' in bag, false, '旧键 budget 不得再发出')
})

test('消费向：发出的 bag 通过契约运行期校验（键名 / 类型逐键一致）', async () => {
  const bag = await produceSearchBag()
  const checked = validateRetrievalSearchBag(bag)
  assert.equal(checked.ok, true, JSON.stringify(checked))
  for (const key of ['query', 'workspace', 'recall_budget']) {
    assert.ok(RETRIEVAL_SEARCH_KEYS.includes(key), `权威键集须含 ${key}`)
  }
  assert.equal(RETRIEVAL_SEARCH_KEYS.includes('workspace_id'), false)
  assert.equal(RETRIEVAL_SEARCH_KEYS.includes('budget'), false)
})

test('供给向：Rust 消费方与 retrieval.json 读取同一组权威键', () => {
  const bagRs = readRepo('plugins/memory-retrieval/src/bag.rs')
  const configRs = readRepo('plugins/memory-retrieval/src/config.rs')
  assert.match(bagRs, /get\("workspace"\)/, 'bag.rs 须按 workspace 取工作区')
  assert.match(bagRs, /get\("query"\)/, 'bag.rs 须按 query 取查询')
  assert.match(configRs, /get\("recall_budget"\)/, 'config.rs 须按 recall_budget 取预算')
  assert.equal(/get\("workspace_id"\)/.test(bagRs), false, 'bag.rs 不得读旧键 workspace_id')
  assert.equal(/get\("budget"\)/.test(configRs), false, 'config.rs 不得读旧键 budget')

  const retrieval = JSON.parse(readRepo('plugins/memory-retrieval/schema/retrieval.json'))
  const searchBag = retrieval.properties.search_bag.properties
  assert.ok(searchBag.workspace, 'retrieval.json 须声明 workspace')
  assert.ok(searchBag.recall_budget, 'retrieval.json 须声明 recall_budget')
  assert.ok(searchBag.query, 'retrieval.json 须声明 query')
})

test('schema：语言中立契约声明权威键，且与生产方输出逐键一致', async () => {
  const schema = JSON.parse(readRepo('chain-contract/schema/retrieval-search.schema.json'))
  assert.ok(schema.properties.workspace, 'schema 须声明 workspace')
  assert.ok(schema.properties.recall_budget, 'schema 须声明 recall_budget')
  assert.ok(schema.properties.query, 'schema 须声明 query')
  const bag = await produceSearchBag()
  for (const key of ['query', 'workspace', 'recall_budget']) {
    assert.equal(bag[key], retrievalSearch.authoritative[key], `${key} 须与 authoritative 夹具一致`)
  }
})
