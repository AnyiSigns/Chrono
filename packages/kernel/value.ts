// 值模型：类型格、规范序列化、结构相等、递归遍历原语。纯函数，零 import（types 除外）。

import { KernelError } from './types.ts'
import type { Json } from './types.ts'

/** 类型格的全序标签（`cmp` 跨型比较按此下标）。运行时冻结：全序口径不可被改写。 */
export const TYPE_ORDER = Object.freeze(['Int', 'Str', 'Bool', 'List', 'Json', 'None'] as const)

/** `TYPE_ORDER` 的取值联合。 */
export type TypeName = (typeof TYPE_ORDER)[number]

/** 递归 JSON 遍历的深度上限：canonicalJson / walkJson / deepEq 共用同一常量。 */
export const MAX_JSON_DEPTH = 64

/**
 * 判定 Json 值的类型标签。
 * 判定顺序焊死：boolean 必须最先，防止任何实现把布尔当整数子类。
 * @param v 待判定的值（`undefined` 归 'None'，与 null 同格）
 * @returns 六型标签之一
 * @throws KernelError('nonfinite') 当 v 是 NaN / ±Infinity——非有限数不进值域
 */
export function t(v: Json | undefined): TypeName {
  if (typeof v === 'boolean') return 'Bool'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new KernelError('nonfinite')
    return 'Int'
  }
  if (typeof v === 'string') return 'Str'
  if (Array.isArray(v)) return 'List'
  if (v === null || v === undefined) return 'None'
  return 'Json'
}

/**
 * 规范序列化：键 code-unit 升序、剔除 undefined 键、-0 归一为 0、最短往返数字表示。
 * 内容哈希的地基——任何两处 `canonicalJson` 相同的值必须逐字节同一串。
 * @param v 待序列化的值
 * @returns 规范化 JSON 串
 * @throws KernelError('undefined') 顶层 undefined；'nonfinite' 非有限数；'depth' 嵌套超过 `MAX_JSON_DEPTH`
 */
export function canonicalJson(v: Json | undefined): string {
  return canon(v, 0)
}

function canon(v: Json | undefined, depth: number): string {
  if (depth > MAX_JSON_DEPTH) throw new KernelError('depth')
  if (v === undefined) throw new KernelError('undefined')
  switch (t(v)) {
    case 'None':
      return 'null'
    case 'Bool':
      return v ? 'true' : 'false'
    case 'Int': {
      if (!Number.isFinite(v as number)) throw new KernelError('nonfinite')
      const n = (v as number) === 0 ? 0 : (v as number) // -0 → 0，否则 H(-0) ≠ H(0)
      return String(n)
    }
    case 'Str':
      return JSON.stringify(v)
    case 'List': {
      const items = v as Json[]
      const parts = new Array<string>(items.length)
      for (let i = 0; i < items.length; i++) parts[i] = canon(items[i], depth + 1)
      return '[' + parts.join(',') + ']'
    }
    default: {
      const record = v as { [k: string]: Json }
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort()
      const fields = new Array<string>(keys.length)
      for (let i = 0; i < keys.length; i++) {
        fields[i] = JSON.stringify(keys[i]) + ':' + canon(record[keys[i]], depth + 1)
      }
      return '{' + fields.join(',') + '}'
    }
  }
}

/** 非 null、非数组的 JSON 对象。 */
export function isRecord(value: unknown): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 64 位小写十六进制哈希串（sha256 全长，不截断）。 */
export function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * 递归 JSON 遍历的访问器：`next(child)` 以 depth+1 递归同一访问器。
 * 容器由访问器自行决定是否下探与如何重建——纯拷贝 / 改写 / 收集 / 剪枝共用同一入口。
 */
export type JsonVisitor = (
  value: Json | undefined,
  depth: number,
  next: (child: Json | undefined) => Json,
) => Json

/**
 * 递归 JSON 遍历的唯一原语：统一深度护栏，逐节点交给 `visitor`。
 * @param value 待遍历的值（`undefined` 原样交给访问器判定）
 * @param visitor 逐节点访问器；其返回值为该节点遍历后的结果
 * @param depth 当前嵌套深度（顶层为 0）
 * @returns 访问器在根节点上的返回值
 * @throws KernelError('depth') 嵌套超过 `MAX_JSON_DEPTH`
 */
export function walkJson(value: Json | undefined, visitor: JsonVisitor, depth: number): Json {
  if (depth > MAX_JSON_DEPTH) throw new KernelError('depth')
  return visitor(value, depth, (child) => walkJson(child, visitor, depth + 1))
}

/**
 * 结构相等，与 canonicalJson 同口径：只比较非 undefined 键；类型不同直接 false，
 * 不做隐式转换（2 与 '2' 不等）。任何输入都返回布尔，不抛错；深度超限返回 false。
 * @param a 左值（可为 undefined）
 * @param b 右值（可为 undefined）
 * @returns 两值在规范口径下是否相等
 */
export function deepEq(a: Json | undefined, b: Json | undefined): boolean {
  return deepEqAt(a, b, 0)
}

function deepEqAt(a: Json | undefined, b: Json | undefined, depth: number): boolean {
  if (depth > MAX_JSON_DEPTH) return false
  if (a === undefined || b === undefined) return a === undefined && b === undefined
  // 数字先行短路：t() 遇非有限数会抛，而 deepEq 必须全输入返回布尔；
  // === 口径下 NaN 与一切不相等，0 === -0 与 canonicalJson 的 -0 归一一致
  if (typeof a === 'number' || typeof b === 'number') {
    return typeof a === 'number' && typeof b === 'number' && a === b
  }
  const ta = t(a)
  const tb = t(b)
  if (ta !== tb) return false
  switch (ta) {
    case 'Bool':
      return a === b
    case 'Str':
      return a === b
    case 'None':
      return true
    case 'List': {
      const la = a as Json[]
      const lb = b as Json[]
      if (la.length !== lb.length) return false
      for (let i = 0; i < la.length; i++) if (!deepEqAt(la[i], lb[i], depth + 1)) return false
      return true
    }
    default: {
      // 单次遍历：键数相等且 a 的每个键在 b 中同名同值；不排序，顺序无关
      const ra = a as { [k: string]: Json | undefined }
      const rb = b as { [k: string]: Json | undefined }
      const keysA = Object.keys(ra).filter((k) => ra[k] !== undefined)
      const keysB = Object.keys(rb).filter((k) => rb[k] !== undefined)
      if (keysA.length !== keysB.length) return false
      for (const key of keysA) {
        const right = rb[key]
        if (right === undefined) return false
        if (!deepEqAt(ra[key], right, depth + 1)) return false
      }
      return true
    }
  }
}
