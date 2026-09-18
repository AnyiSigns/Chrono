// term 源里的 callee 引用：`{"$ref":"terms/foo.json"}` 保留占位符的纯结构处理。
// 只认「单一保留键 + 字符串」的形状；替换成 callee def 哈希，不解释 Call 语义、不推断依赖。

import type { Hash, Json } from '../../kernel/index.ts'

/** 规范化 `$ref` 相对路径；空路径或含 `..` 段返回 null。 */
export function normalizeRefPath(ref: string): string | null {
  const segments = ref.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  return segments.join('/')
}

/** 深度遍历，收集所有 `$ref` 占位符的目标路径（原样，未规范化）。 */
export function collectRefs(value: Json, out: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as { [k: string]: Json }
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === '$ref' && typeof record['$ref'] === 'string') {
    out.push(record['$ref'] as string)
    return
  }
  for (const key of keys) collectRefs(record[key], out)
}

/**
 * 把 AST 里的 `$ref` 占位符替换成 callee def 哈希；`resolve` 返回 null 即失败。
 * 替换是纯结构的：命中即替换，其余原样（不动输入）。
 */
export function replaceTermRefs(
  value: Json,
  resolve: (refPath: string) => Hash | null,
): { ok: true; value: Json } | { ok: false } {
  if (Array.isArray(value)) {
    const out: Json[] = []
    for (const item of value) {
      const replaced = replaceTermRefs(item, resolve)
      if (!replaced.ok) return replaced
      out.push(replaced.value)
    }
    return { ok: true, value: out }
  }
  if (typeof value !== 'object' || value === null) return { ok: true, value }
  const record = value as { [k: string]: Json }
  const keys = Object.keys(record)
  if (keys.length === 1 && keys[0] === '$ref' && typeof record['$ref'] === 'string') {
    const target = normalizeRefPath(record['$ref'] as string)
    if (target === null) return { ok: false }
    const hash = resolve(target)
    if (hash === null) return { ok: false }
    return { ok: true, value: hash }
  }
  const out: { [k: string]: Json } = {}
  for (const key of keys) {
    const replaced = replaceTermRefs(record[key], resolve)
    if (!replaced.ok) return replaced
    out[key] = replaced.value
  }
  return { ok: true, value: out }
}

/**
 * 包内 term 引用图的拓扑序（callee 先于 caller）；成环返回 null。
 * `refsOf` 给出每个结点直接引用的目标（可含重复 / 未过滤项，本函数会去重并忽略图外结点）。
 */
export function termTopoOrder(
  paths: string[],
  refsOf: (path: string) => string[],
): string[] | null {
  const known = new Set(paths)
  const remaining = new Map<string, number>()
  const callers = new Map<string, Set<string>>()
  for (const path of paths) {
    const callees = new Set(refsOf(path).filter((ref) => known.has(ref)))
    remaining.set(path, callees.size)
    for (const callee of callees) {
      const list = callers.get(callee)
      if (list === undefined) callers.set(callee, new Set([path]))
      else list.add(path)
    }
  }
  const ready = paths.filter((path) => remaining.get(path) === 0).sort()
  const order: string[] = []
  while (ready.length > 0) {
    const current = ready.shift() as string
    order.push(current)
    for (const caller of callers.get(current) ?? []) {
      const left = (remaining.get(caller) as number) - 1
      remaining.set(caller, left)
      if (left === 0) {
        const index = ready.findIndex((path) => path > caller)
        if (index < 0) ready.push(caller)
        else ready.splice(index, 0, caller)
      }
    }
  }
  return order.length === paths.length ? order : null
}
