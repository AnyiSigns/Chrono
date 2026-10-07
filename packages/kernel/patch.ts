// 补丁原语（内容型世代组装）：基础 body + 有序补丁 → 组装 body。
// 三种操作与路径口径对齐内容工作区的通用补丁语义：
//   append  —— 列表追加 / 字符串拼接（路径不存在时按值建列表）；
//   replace —— 路径整体替换（中间容器不存在时按下一段类型新建）；
//   delete  —— 删除路径指向的值（路径不存在时静默成功，幂等）。
// 组装是纯函数：不改 base、不改补丁、产物不共享补丁 value 引用（防外部改写污染链）。
// 非法补丁 fail-closed：未知 op / 空路径 / 穿过标量的路径 / append 目标非列表非字符串，
// 一律抛 KernelError('bad_patch')，不静默吞掉。

import { isRecord, walkJson } from './value.ts'
import { KernelError } from './types.ts'
import type { Json } from './types.ts'

/** 补丁路径：对象键为 str、数组下标为 int；空路径非法。 */
export type PatchPath = (string | number)[]

/** 单条补丁：op 决定 value 的用法（delete 忽略 value）。 */
export interface PatchOp {
  op: 'append' | 'replace' | 'delete'
  path: PatchPath
  value?: Json
}

const PATCH_OPS = Object.freeze(['append', 'replace', 'delete'] as const)

function isPathSegment(v: Json): v is string | number {
  return typeof v === 'string' || (typeof v === 'number' && Number.isInteger(v))
}

/** 单条补丁形态检查：op 合法、path 为非空 (str|int) 数组。 */
function isPatchOp(v: Json): boolean {
  if (!isRecord(v)) return false
  const op = v['op']
  if (typeof op !== 'string' || !(PATCH_OPS as readonly string[]).includes(op)) return false
  const path = v['path']
  if (!Array.isArray(path) || path.length === 0) return false
  return path.every(isPathSegment)
}

/** 补丁 def body 形态：`{ ops: [补丁…] }`；非法返回 null（调用方决定拒或忽略）。 */
export function readPatchOps(body: Json): PatchOp[] | null {
  if (!isRecord(body)) return null
  const ops = body['ops']
  if (!Array.isArray(ops) || ops.length === 0) return null
  if (!ops.every(isPatchOp)) return null
  return ops as unknown as PatchOp[]
}

/** JSON 兼容深拷贝：标量原样、容器递归复制（补丁 value 不得与链共享引用）。 */
function deepCopy(value: Json | undefined): Json {
  return walkJson(value, copyNode, 0)
}

function copyNode(
  value: Json | undefined,
  _depth: number,
  next: (child: Json | undefined) => Json,
): Json {
  if (Array.isArray(value)) return value.map(next)
  if (value !== null && typeof value === 'object') {
    const out: { [k: string]: Json } = {}
    for (const key of Object.keys(value)) out[key] = next((value as { [k: string]: Json })[key])
    return out
  }
  return value === undefined ? null : value
}

/** 沿路径取容器/叶子；返回 `{found, node}`（缺失一律 found=false，不抛）。 */
function resolve(doc: Json, path: PatchPath): { found: boolean; node: Json } {
  let node: Json = doc
  for (const seg of path) {
    if (isRecord(node)) {
      if (!Object.hasOwn(node, seg)) return { found: false, node: null }
      node = node[seg]
    } else if (Array.isArray(node) && typeof seg === 'number' && seg >= 0 && seg < node.length) {
      node = node[seg]
    } else {
      return { found: false, node: null }
    }
  }
  return { found: true, node }
}

/** 就地写叶子：中间容器不存在时按下一段类型新建；穿过标量抛 bad_patch。 */
function setPath(doc: Json, path: PatchPath, value: Json): void {
  let node: Json = doc
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]
    const next = path[i + 1]
    if (isRecord(node)) {
      const child = Object.hasOwn(node, seg) ? node[seg] : undefined
      if (child === undefined || child === null) {
        const created: Json = typeof next === 'string' ? {} : []
        node[seg] = created
        node = created
      } else if (isRecord(child) || Array.isArray(child)) {
        node = child
      } else {
        throw new KernelError('bad_patch')
      }
    } else if (Array.isArray(node) && typeof seg === 'number' && seg >= 0) {
      while (node.length <= seg) node.push(null)
      const child = node[seg]
      if (child === null || child === undefined) {
        const created: Json = typeof next === 'string' ? {} : []
        node[seg] = created
        node = created
      } else if (isRecord(child) || Array.isArray(child)) {
        node = child
      } else {
        throw new KernelError('bad_patch')
      }
    } else {
      throw new KernelError('bad_patch')
    }
  }
  const last = path[path.length - 1]
  if (Array.isArray(node) && typeof last === 'number' && last >= 0) {
    while (node.length <= last) node.push(null)
    node[last] = value
  } else if (isRecord(node) && typeof last === 'string') {
    node[last] = value
  } else {
    throw new KernelError('bad_patch')
  }
}

/** 就地应用单条补丁；失败抛 KernelError('bad_patch')。 */
function applyOne(doc: Json, patch: PatchOp): void {
  if (patch.op === 'append') {
    const { found, node } = resolve(doc, patch.path)
    if (!found || node === null) {
      setPath(doc, patch.path, patch.value === undefined ? [] : [deepCopy(patch.value)])
      return
    }
    if (Array.isArray(node)) {
      node.push(deepCopy(patch.value))
      return
    }
    if (typeof node === 'string') {
      setPath(doc, patch.path, node + String(patch.value ?? ''))
      return
    }
    throw new KernelError('bad_patch')
  }
  if (patch.op === 'replace') {
    setPath(doc, patch.path, deepCopy(patch.value))
    return
  }
  if (patch.op !== 'delete') throw new KernelError('bad_patch')
  // delete：路径缺失即视为已删除（幂等）
  let node: Json = doc
  for (let i = 0; i < patch.path.length - 1; i++) {
    const seg = patch.path[i]
    if (isRecord(node)) {
      if (!Object.hasOwn(node, seg)) return
      node = node[seg]
    } else if (Array.isArray(node) && typeof seg === 'number' && seg >= 0 && seg < node.length) {
      node = node[seg]
    } else {
      return
    }
  }
  const last = patch.path[patch.path.length - 1]
  if (isRecord(node) && typeof last === 'string') delete node[last]
  else if (Array.isArray(node) && typeof last === 'number' && last >= 0 && last < node.length)
    node.splice(last, 1)
}

/**
 * 组装：以 base 为起点按序应用补丁，返回新文档（纯函数）。
 * @param base 基础 body（不修改）
 * @param patches 有序补丁（不修改）
 * @returns 组装后的 body
 * @throws KernelError('bad_patch') 未知 op / 空路径 / 路径穿过标量 / append 目标非法
 */
export function assembleBody(base: Json, patches: PatchOp[]): Json {
  const doc = deepCopy(base)
  for (const patch of patches) applyOne(doc, patch)
  return doc
}
