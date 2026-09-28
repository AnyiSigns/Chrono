// 阈值单一真源：loop-policy 解析后的扁平 thresholds map 随 context.assemble bag 下传，
// 消费方 context-window 据此覆盖自身 policy 默认（含 large_artifact_bytes）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './driver.mjs'
import { seedModel } from '../execute/seed.ts'

function graphWith(thresholds) {
  const seed = seedModel()
  return {
    contracts: seed.contracts,
    nodes: seed.nodes,
    prompts: seed.prompts,
    graph: seed.graph,
    thresholds: { ...seed.thresholds, ...thresholds },
    refusal_codes: seed.refusalCodes,
  }
}

function contextBuildArgs(service) {
  const call = service.portCalls.find((entry) => entry.port === 'context' && entry.method === 'build')
  return call?.args ?? null
}

test('context.assemble bag 携带 loop-policy 解析后的 thresholds（图阈值覆盖生效）', async () => {
  const service = startService()
  try {
    await service.interpret({ turn_id: 't1', graph: graphWith({ large_artifact_bytes: 12345 }) })
    const args = contextBuildArgs(service)
    assert.ok(args, 'context.build 应被派发')
    assert.equal(args.thresholds.large_artifact_bytes, 12345)
  } finally {
    service.close()
  }
})

test('未覆盖时默认 large_artifact_bytes 随 context bag 下传（单一真源方向）', async () => {
  const service = startService()
  try {
    await service.interpret({ turn_id: 't1' })
    const args = contextBuildArgs(service)
    assert.ok(args)
    assert.equal(args.thresholds.large_artifact_bytes, 65536)
  } finally {
    service.close()
  }
})
