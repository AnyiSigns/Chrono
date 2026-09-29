// 服务内部共享类型（纯类型声明；不 import 宿主与内核）。

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 图六类条目 + 阈值的归一模型（服务不读投影：全部来自 bag / args）。 */
export interface GraphModel {
  contracts: Rec[]
  nodes: Rec[]
  prompts: Rec
  graph: Rec
  thresholds: Rec
  refusalCodes: Rec[]
}
