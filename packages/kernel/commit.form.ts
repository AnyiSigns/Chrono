// validate 的形态检查（形状表；从 commit.ts 点分段拆出——预算护栏）。
// 公共面由 commit.ts 统一转口，本文件不进 index。

import type { Json, WriteRequest } from './types.ts'

type Rec = { [k: string]: Json }

const VALID_OPS: readonly string[] = Object.freeze(
  'put add_identity add_gen set_active retire fork graft batch note snapshot'.split(' '),
)

function isHash(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
}

function isNonemptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isGenIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0
}

function isPinSet(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  for (const item of Object.values(v as Record<string, unknown>)) if (!isHash(item)) return false
  return true
}

function isGraftRef(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const g = v as Rec
  return isNonemptyString(g['from']) && isGenIndex(g['gen']) && Object.keys(g).length === 2
}

/** 形态检查：op ∈ Op；expect_pos = 64-hex 或 null；args 符合该 op 形状（形状表）。 */
export function hasForm(req: WriteRequest): boolean {
  if (!isNonemptyString(req.by) || !isNonemptyString(req.id)) return false
  if (!VALID_OPS.includes(req.op)) return false
  if (!isHash(req.target.expect_pos) && req.target.expect_pos !== null) return false
  if (req.ref !== undefined && !isHash(req.ref)) return false
  const a = req.args
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return false
  const r = a as Rec
  const keys = Object.keys(r)
  const exact = (reqd: string[], opt: string[]): boolean =>
    keys.every((k) => reqd.includes(k) || opt.includes(k)) && reqd.every((k) => keys.includes(k))
  return (FORM_CHECKS[req.op] ?? (() => false))({ r, keys, exact })
}

interface ArgShape {
  r: Rec
  keys: string[]
  exact: (reqd: string[], opt: string[]) => boolean
}

const GEN_KEYS = ['id', 'payload', 'pins', 'sig']

const genBaseOk = (c: ArgShape): boolean =>
  isNonemptyString(c.r['id']) &&
  isHash(c.r['payload']) &&
  isPinSet(c.r['pins']) &&
  isHash(c.r['sig'])

const FORM_CHECKS: { [op: string]: (c: ArgShape) => boolean } = {
  put: (c) =>
    c.exact(['body'], ['pins', 'sig']) &&
    (!('pins' in c.r) || isPinSet(c.r['pins'])) &&
    (!('sig' in c.r) || isHash(c.r['sig'])),
  note: () => true, // 任意 JSON 对象 = 留痕载荷（§11.2 形状表）：hasForm 前置已保证 args 是非 null、非数组对象
  snapshot: (c) => c.exact(['world_rev'], []) && isHash(c.r['world_rev']),
  add_identity: (c) =>
    c.exact(['id', 'schema'], ['parent']) &&
    isNonemptyString(c.r['id']) &&
    isHash(c.r['schema']) &&
    (!('parent' in c.r) || isNonemptyString(c.r['parent'])),
  fork: (c) =>
    c.exact(['id', 'schema', 'parent'], []) &&
    isNonemptyString(c.r['id']) &&
    isHash(c.r['schema']) &&
    isNonemptyString(c.r['parent']),
  set_active: (c) =>
    c.exact(['id', 'active'], []) &&
    isNonemptyString(c.r['id']) &&
    (isHash(c.r['active']) || c.r['active'] === null),
  retire: (c) => c.exact(['id'], []) && isNonemptyString(c.r['id']),
  add_gen: (c) => {
    if ('seq' in c.r) return false // seq 由内核分配，携带即 bad_form
    return (
      c.exact(GEN_KEYS, ['graft', 'expect_active', 'base']) &&
      genBaseOk(c) &&
      (!('graft' in c.r) || isGraftRef(c.r['graft'])) &&
      (!('base' in c.r) || isGenIndex(c.r['base'])) &&
      (!('expect_active' in c.r) || isHash(c.r['expect_active']) || c.r['expect_active'] === null)
    )
  },
  graft: (c) =>
    !('seq' in c.r) &&
    c.exact([...GEN_KEYS, 'from', 'gen'], []) &&
    genBaseOk(c) &&
    isNonemptyString(c.r['from']) &&
    isGenIndex(c.r['gen']),
  batch: (c) => {
    if (!c.exact(['ops'], []) || !Array.isArray(c.r['ops'])) return false
    for (const item of c.r['ops'] as Json[]) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return false
      const sub = item as Rec
      const subKeys = Object.keys(sub)
      if (subKeys.length !== 2) return false
      if (!subKeys.every((k) => k === 'op' || k === 'args')) return false
      if (!(typeof sub['op'] === 'string' && VALID_OPS.includes(sub['op']))) return false
    }
    return true
  },
}
