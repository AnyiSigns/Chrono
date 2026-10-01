// 结构 op 名单单源守护：真源在内核 `packages/kernel/ops.ts` 的 `OP_NAMES`——
// `Op` 类型联合、写口 `VALID_OPS` 与宿主镜像 `packages/host/common/op-names.ts` 都由它派生。
// 本测试断言宿主镜像逐字（含顺序）等于内核真源，防止镜像被手写回去而漂移。
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { OP_NAMES as HOST_OP_NAMES } from '../../packages/host/common/op-names.ts'
import { OP_NAMES as KERNEL_OP_NAMES } from '../../packages/kernel/index.ts'

test('结构 op 名单单源：宿主镜像与内核 OP_NAMES 逐字一致', () => {
  const canonical = [...KERNEL_OP_NAMES]
  // 覆盖兜底：真源确实解析出足量 op，防清单被误清空导致空转比对。
  assert.ok(canonical.length >= 10, `内核 OP_NAMES 过少（${canonical.length}）`)
  assert.equal(new Set(canonical).size, canonical.length, '内核 OP_NAMES 自身含重复 op')
  assert.deepEqual(
    [...HOST_OP_NAMES],
    canonical,
    `宿主 op 镜像漂移（基准 packages/kernel/ops.ts = [${canonical.join(', ')}]）`,
  )
})
