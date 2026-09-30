// 真 pin 闭包基线：从 `chat` 沿 `plugins/*/plugin.json` 的 `pins` 走完，钉住世界装配所需身份集与其中的原生构建件。
// 不采信任何文档给出的规模估计；此处断言的是**实际算出的**闭包。数量变化意味着装配面变化，需在此显式更新。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeClosure, cargoIdentities } from '../harness/index.mjs'

const EXPECTED_CLOSURE = [
  'approval',
  'chat',
  'compress',
  'config',
  'context-window',
  'embedding',
  'evolve-metrics',
  'graph-run',
  'guard',
  'input',
  'loop-policy',
  'mcp',
  'memory-consolidate',
  'memory-retrieval',
  'memory-store',
  'model-protocol',
  'orchestration-admin',
  'plugin-admin',
  'question',
  'router',
  'sandbox',
  'secrets',
  'session',
  'session-title',
  'short-memory',
  'skill',
  'storage-kv',
  'todo',
  'tool-browser',
  'tool-fs',
  'tool-http',
  'tool-shell',
  'tools',
  'turn-ledger',
  'workspace',
]

const EXPECTED_CARGO = [
  'context-window',
  'embedding',
  'evolve-metrics',
  'memory-retrieval',
  'sandbox',
  'tool-fs',
  'workspace',
]

test('chat 的传递 pin 闭包 = 35 个身份', () => {
  const closure = computeClosure('chat')
  assert.deepEqual(closure, EXPECTED_CLOSURE)
})

test('闭包内的原生（cargo）构建件 = 7 个', () => {
  const cargo = cargoIdentities(computeClosure('chat'))
  assert.deepEqual(cargo, EXPECTED_CARGO)
})
