// 身份名安全约束：身份名会被用作 ③ 目录名（`state/plugins/<id>/`），必须是**安全单段名**。
// 同时用于入世校验与运行期起服务边界：世界可被运行期写指令创建任意 id，不能只信任入世路径。

/** Windows 保留设备名：这些名字无法作为目录名，命中即拒。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** JS 原型键：作为对象键会命中继承成员（`world.ids[id]` 不为 undefined），须显式拒绝。 */
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * 身份名是否安全：非空、限长、单段、无路径穿越、无 Windows 非法字符 / 保留名 / 尾随点空格、
 * 非 JS 原型键，且不是保留身份名 `host`（`host` 恒解析为宿主能力，真实身份会被遮蔽）。
 */
export function isSafeIdentityName(id: string): boolean {
  if (id.length === 0 || id.length > 128) return false
  if (id === 'host') return false
  if (id === '.' || id === '..') return false
  if (id.includes('/') || id.includes('\\')) return false
  if (/^[A-Za-z]:/.test(id)) return false
  if (/[\u0000-\u001f]/.test(id)) return false
  if (/[<>:"|?*]/.test(id)) return false
  if (id.endsWith('.') || id.endsWith(' ')) return false
  if (WINDOWS_RESERVED.test(id)) return false
  if (PROTO_KEYS.has(id)) return false
  return true
}
