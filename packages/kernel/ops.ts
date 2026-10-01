// 结构 op 名单的单一真源：`Op` 类型联合与写口运行期校验共用此表，
// 宿主侧镜像（`packages/host/common/op-names.ts`）由本表派生，杜绝多处清单漂移。

/** 合法结构 op 名；顺序即索引 / 校验依赖的顺序。 */
export const OP_NAMES = [
  'put',
  'add_identity',
  'add_gen',
  'set_active',
  'retire',
  'fork',
  'graft',
  'batch',
  'note',
  'snapshot',
] as const

/** 结构 op 名联合类型，由 `OP_NAMES` 派生。 */
export type Op = (typeof OP_NAMES)[number]
