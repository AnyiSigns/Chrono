// 结构 op 名单的宿主镜像（与内核同源）：从内核 `OP_NAMES` 派生，供入站 write 形态校验与 plan 物化共用。
// 单一真源在内核 `packages/kernel/ops.ts`，本文件不再手写清单，杜绝两处漂移。

import { OP_NAMES as KERNEL_OP_NAMES } from '../../kernel/index.ts'

/** 合法结构 op 名：入站 write 与 plan 条目校验用。 */
export const OP_NAMES: ReadonlySet<string> = new Set(KERNEL_OP_NAMES)
