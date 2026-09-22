// 服务内部共享工具与错误类型（纯 JS，无类型声明）。

/** 判定一个值是否为普通对象（非 null、非数组）。 */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空字符串取值；否则 null。 */
export function asString(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** args 形态非法（非对象 / 缺必需字段）：结构化 bad_args，不崩进程、不产计划。 */
export class BadArgsError extends Error {
  constructor(message) {
    super(message)
    this.name = 'BadArgsError'
  }
}
