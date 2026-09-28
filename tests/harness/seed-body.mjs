// 数据世代写入辅助：把一份 body 作为某身份的**数据世代**提交进世界（`put` + `add_gen`）。
// 与各插件自带的 `tools/seed-default-body.mjs` 同机制（原子 batch、expect_pos 乐观锁），
// 供 e2e 装配测试所需的规则 / 阈值数据（如 guard 的拒绝清单、loop-policy 的预算阈值）。
// 只做确定性构造与提交，不改插件源码、不改世界写口。

import { SEED_GRAPH } from '../../plugins/loop-policy/execute/seed.ts'

/** 当前链头哈希（batch 的 expect_pos）。 */
async function headHash(client) {
  const status = await client.status()
  return status.world_head.hash
}

/**
 * 提交一条数据世代：`put(body)` + `add_gen(identity)`。
 * 同内容重复提交由 `put` 的幂等短路收敛，可安全重试。
 */
export async function seedIdentityBody(client, identity, body, options = {}) {
  const expectPos = await headHash(client)
  const directive = [
    {
      kind: 'write',
      request: {
        id: options.requestId ?? `${identity}-e2e-body`,
        op: 'batch',
        target: { expect_pos: expectPos },
        args: {
          ops: [
            { op: 'put', args: { body } },
            { op: 'add_gen', args: { id: identity, payload: { $n: 0 }, sig: { $n: 0 }, pins: {} } },
          ],
        },
        by: 'e2e-seed',
      },
    },
  ]
  return client.submit(directive)
}

/**
 * loop-policy 预算阈值覆盖 body：内联包内种子图 + 指定阈值（缺省不覆盖）。
 * 图必须可用（节点 ∈ 种子契约 id），故内联 `SEED_GRAPH`；`resolveModel` 会把该阈值合并进默认。
 */
export function loopPolicyBudgetBody({ maxTurnIter, maxSteps, checkpointSoftRatio } = {}) {
  const thresholds = {}
  if (typeof maxTurnIter === 'number') thresholds['max_turn_iter'] = maxTurnIter
  if (typeof maxSteps === 'number') thresholds['max_steps'] = maxSteps
  if (typeof checkpointSoftRatio === 'number') thresholds['checkpoint_soft_ratio'] = checkpointSoftRatio
  return { graph: SEED_GRAPH, thresholds }
}
