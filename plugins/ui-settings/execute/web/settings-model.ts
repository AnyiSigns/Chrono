// 设置页纯函数（node 下可 import 单测）：tab 表 / 身份只读行 / 技能清单读写。

import { clone, isRecord, joinMeta } from './config-model.ts'
import { shortHash } from './health.ts'

/** 左侧 tab（图标名取自 icons.v2.svg 的登记子集）。 */
export const TABS = [
  { id: 'general', icon: 'settings' },
  { id: 'model', icon: 'cpu' },
  { id: 'plugins', icon: 'puzzle' },
  { id: 'skills', icon: 'sparkles' },
  { id: 'memory', icon: 'brain' },
  { id: 'orchestration', icon: 'git-branch' },
  { id: 'about', icon: 'info' },
]

/** 合法 tab id 集合（用于兜底到通用页）。 */
export function normalizeTab(tab: any): string {
  return TABS.some((item) => item.id === tab) ? tab : 'general'
}

/** 身份只读行（插件页 / 关于页计数）。 */
export function identityRows(ids: any): any[] {
  if (!isRecord(ids)) return []
  const rows: any[] = []
  for (const id of Object.keys(ids)) {
    const entry = ids[id]
    if (!isRecord(entry)) continue
    const gens = Array.isArray(entry.gens) ? entry.gens : []
    rows.push({
      id,
      retired: entry.active === null,
      active: typeof entry.active === 'string' ? entry.active : null,
      activeShort: typeof entry.active === 'string' ? shortHash(entry.active) : '',
      genCount: gens.length,
      pins: isRecord(entry.pins) ? entry.pins : {},
    })
  }
  rows.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return rows
}

/** 插件数（关于页）。 */
export function pluginCount(ids: any): number {
  return identityRows(ids).length
}

/** 技能清单（技能页）；技能身份未就绪 / body 缺键 → 空列表。 */
export function skillList(projection: any): any[] {
  if (!isRecord(projection) || !isRecord(projection.body)) return []
  const skills = projection.body.skills
  return Array.isArray(skills) ? skills.filter((item: any) => isRecord(item)) : []
}

/** 新增 / 覆盖一条技能；返回新 body（不修改入参）。 */
export function upsertSkill(body: any, skill: any): any {
  const base = isRecord(body) ? clone(body) : { version: 1, skills: [] }
  const skills = Array.isArray(base.skills) ? base.skills.slice() : []
  const index = skills.findIndex((item: any) => isRecord(item) && item.id === skill.id)
  if (index >= 0) skills[index] = skill
  else skills.push(skill)
  base.skills = skills
  return base
}

/** 删除一条技能。 */
export function removeSkill(body: any, id: string): any {
  const base = isRecord(body) ? clone(body) : { version: 1, skills: [] }
  base.skills = (Array.isArray(base.skills) ? base.skills : []).filter(
    (item: any) => !(isRecord(item) && item.id === id),
  )
  return base
}

/** 启停一条技能。 */
export function toggleSkill(body: any, id: string, enabled: any): any {
  const base = isRecord(body) ? clone(body) : { version: 1, skills: [] }
  base.skills = (Array.isArray(base.skills) ? base.skills : []).map((item: any) =>
    isRecord(item) && item.id === id ? { ...item, enabled: enabled === true } : item,
  )
  return base
}

/** 技能表单 → 技能条目（`keywords` 支持逗号 / 空白分隔）。 */
export function skillFromForm(form: any, id: string, at: string): any {
  const keywords = splitList(form.keywords)
  const fileGlobs = splitList(form.file_globs)
  const explicit = splitList(form.explicit)
  const scope =
    form.scope_kind === 'workspace' && typeof form.workspace_id === 'string' && form.workspace_id.length > 0
      ? { kind: 'workspace', workspace_id: form.workspace_id }
      : { kind: 'global' }
  return {
    id,
    name: form.name,
    description: form.description,
    triggers: { keywords, file_globs: fileGlobs, explicit },
    scope,
    body: form.body,
    enabled: form.enabled !== false,
    at,
  }
}

/** 逗号 / 空白分隔列表 → 去重数组。 */
export function splitList(value: any): string[] {
  if (typeof value !== 'string') return []
  return [
    ...new Set(
      value
        .split(/[,\uFF0C\s]+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  ]
}

/** 列表 → 表单回填文本（`splitList` 的逆操作，逗号分隔）。 */
export function listText(value: any): string {
  return Array.isArray(value) ? value.join(', ') : ''
}

/** 技能行主文本：`name`（缺失回落 `id`）与 `description` 以 ` · ` 连接。 */
export function skillTitle(skill: any): string {
  if (!isRecord(skill)) return ''
  const name = typeof skill.name === 'string' && skill.name.length > 0 ? skill.name : typeof skill.id === 'string' ? skill.id : ''
  const description = typeof skill.description === 'string' ? skill.description : ''
  return joinMeta([name, description])
}

/** 插件行副文本片段：世代短哈希 + 依赖 pins 摘要（组件用 `joinMeta` 连接）。 */
export function pluginSubParts(row: any, t: (code: string) => string): string[] {
  const parts: string[] = []
  if (typeof row?.activeShort === 'string' && row.activeShort.length > 0) {
    parts.push(`${t('settings_plugins_generation')} ${row.activeShort}`)
  }
  const pins = isRecord(row?.pins) ? Object.keys(row.pins) : []
  if (pins.length > 0) parts.push(`${t('settings_plugins_deps')} ${pins.join(', ')}`)
  return parts
}
