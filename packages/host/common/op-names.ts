// 结构 op 名单的单一真源（与内核 `Op` 同口径）：入站 write 形态校验与 plan 物化共用，防止两处清单漂移。

/** 合法结构 op 名：入站 write 与 plan 条目校验用。 */
export const OP_NAMES: ReadonlySet<string> = new Set([
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
])
