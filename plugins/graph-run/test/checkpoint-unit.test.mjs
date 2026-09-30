// 段边界检查点的纯函数级测试：档位判定与上下文压力（协议级行为住 loop-policy 门面测试）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkpointLevel, checkpointThresholds, contextPressure } from '../execute/checkpoint.ts'

test('档位判定：软 / 硬 / 应急三档，bag.checkpoint_thresholds 可覆盖', () => {
  const model = { thresholds: { checkpoint_soft_ratio: 0.7, checkpoint_hard_ratio: 0.85, checkpoint_emergency_ratio: 0.95 } }
  const thresholds = checkpointThresholds(model, {})
  assert.equal(checkpointLevel(0.69, thresholds), null)
  assert.equal(checkpointLevel(0.7, thresholds), 'soft')
  assert.equal(checkpointLevel(0.85, thresholds), 'hard')
  assert.equal(checkpointLevel(0.95, thresholds), 'emergency')
  const override = checkpointThresholds(model, { checkpoint_thresholds: { soft: 0.5 } })
  assert.equal(override.soft, 0.5)
  assert.equal(override.hard, 0.85)
})

test('压力：缺清单 / 预算非正不触发', () => {
  assert.equal(contextPressure({ shared: {} }), null)
  assert.equal(contextPressure({ shared: { context_manifest: { used: 5, budget: 0 } } }), null)
  assert.equal(contextPressure({ shared: { context_manifest: { used: 5, budget: 10 } } }).ratio, 0.5)
})
