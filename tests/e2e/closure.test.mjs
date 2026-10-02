// 真依赖闭包基线：从 `chat` 沿 `plugins/*/plugin.json` 的 `needs` `one` 绑定解析唯一提供方——
// `one` 绑定即 DAG 闭包边（`host` 哨兵与 `many` 不计入单值边）。boot 世界另需闭包内身份的
// needs 目标提供方在场，故世界身份集 = one-needs 闭包 ∪ needs 目标。
// 不采信任何文档给出的规模估计；此处断言的是**实际算出的**集合。数量变化意味着装配面变化，需在此显式更新。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NATIVE_CARGO_IDENTITIES, cargoIdentities, computeClosure, computeWorldIdentities, toyFor } from '../harness/index.mjs'

// chat 沿 `needs.one` 的传递闭包（提供方唯一才成边；`host` 哨兵不计）。
const EXPECTED_PIN_CLOSURE = [
  'approval',
  'budget',
  'chat',
  'config',
  'context-window',
  'evolve-ledger',
  'graph-gate',
  'graph-run',
  'guard',
  'input',
  'loop-policy',
  'mcp',
  'mcp-client',
  'model-protocol',
  'msg-dialect',
  'ref-hydrate',
  'router',
  'secrets',
  'session',
  'skill',
  'storage-kv',
  'throttle',
  'todo',
  'token-estimate',
  'tool-dispatch',
  'tool-registry',
  'turn-ledger',
  'workspace',
]

// 世界身份集 = one-needs 闭包 ∪ 传递 needs 目标提供方（`many` 取全部提供方）。
const EXPECTED_WORLD = [
  'approval',
  'budget',
  'chat',
  'config',
  'context-window',
  'evolve-ledger',
  'graph-gate',
  'graph-run',
  'guard',
  'input',
  'loop-policy',
  'mcp',
  'mcp-client',
  'model-protocol',
  'msg-dialect',
  'orchestration',
  'plugin',
  'plugin-admin',
  'question',
  'ref-hydrate',
  'router',
  'sandbox',
  'sandbox-exec',
  'sandbox-fs',
  'sandbox-policy',
  'search-index',
  'search-index-sql',
  'secrets',
  'secrets-env',
  'secrets-local',
  'session',
  'skill',
  'storage-kv',
  'throttle',
  'todo',
  'token-estimate',
  'tool-browser',
  'tool-dispatch',
  'tool-fs',
  'tool-http',
  'tool-registry',
  'tool-shell',
  'turn-ledger',
  'workspace',
]

const EXPECTED_CARGO = [
  'evolve-ledger',
  'sandbox',
  'sandbox-exec',
  'sandbox-fs',
  'sandbox-policy',
  'token-estimate',
  'tool-fs',
  'workspace',
]

test('chat 的传递 one-needs 闭包 = 28 个身份', () => {
  assert.deepEqual(computeClosure('chat'), EXPECTED_PIN_CLOSURE)
})

test('chat 的世界身份集 = one-needs 闭包 ∪ 传递 needs 目标 = 44 个身份', () => {
  assert.deepEqual(computeWorldIdentities('chat'), EXPECTED_WORLD)
})

test('世界内的原生（cargo）构建件 = 8 个', () => {
  assert.deepEqual(cargoIdentities(EXPECTED_WORLD), EXPECTED_CARGO)
})

test('世界内除原生承载身份外，每个 cargo 身份都有同身份 toy 替身', () => {
  const missing = EXPECTED_CARGO.filter((id) => !NATIVE_CARGO_IDENTITIES.has(id) && toyFor(id) === null)
  assert.deepEqual(missing, [])
})
