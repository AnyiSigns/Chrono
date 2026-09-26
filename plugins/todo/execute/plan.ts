// 共享纯函数：JSON 形态判定与字段取值。清单本体已出世界，本文件不再构造写计划。
// 服务不读投影、不落账、不自取时钟。

import { asString, isRecord } from 'plugin-sdk'
import type { Json } from 'plugin-sdk'

export { asString, isRecord }

/** 数组取值；非数组回 null。 */
export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null
}
