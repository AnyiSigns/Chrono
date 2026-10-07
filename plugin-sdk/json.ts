// JSON 值模型与形态判定：SDK 内部与插件服务共用的最小 JSON 面。
// 纯类型与纯函数，零内核零宿主依赖。

/** JSON 值。 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** 普通对象（非数组、非 null）。 */
export type Rec = { [key: string]: Json }

/** 非 null、非数组的对象。 */
export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串；否则 null。 */
export function asString(value: Json | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
