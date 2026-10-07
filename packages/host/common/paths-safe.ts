// 路径安全：身份名单段校验、包内相对路径校验、路径段拆分与引用路径规范化。
// 身份名会被用作 ③ / ④ 目录名，包内路径会落到物化目录，故一律 fail-closed 拒绝逃逸写法。

import { PROTOTYPE_KEYS } from './json.ts'

/** Windows 保留设备名（含带扩展名形态）：无法作为文件 / 目录名，命中即拒。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Windows 保留设备名的裸段集合（小写、不含扩展名），供逐段路径校验。 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
])

/** 单个路径段允许的字符：排除 Windows 非法字符与控制字符。 */
const SAFE_SEGMENT = /^[^/\\<>:"|?*\u0000-\u001f]+$/

/** 包内相对路径的长度上限（与 `validate_package` 的候选文件路径同口径）。 */
const MAX_RELATIVE_PATH_LENGTH = 4096

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
  if (PROTOTYPE_KEYS.has(id)) return false
  return true
}

/**
 * 把相对路径拆成路径段：空段与 `.` 丢弃，`..` 视为非法（返回 null）。
 * 只做机械拆分，不判字符合法性。
 */
export function pathSegments(relPath: string): string[] | null {
  const segments = relPath.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.some((segment) => segment === '..')) return null
  return segments
}

/** 规范化 `$ref` 相对路径；空路径或含 `..` 段返回 null。 */
export function normalizeRefPath(ref: string): string | null {
  const segments = pathSegments(ref)
  if (segments === null || segments.length === 0) return null
  return segments.join('/')
}

/**
 * 包内相对路径是否安全（宽松口径）：非空、无绝对前缀 / 反斜杠 / 盘符、无 `..` 段。
 * 空段与 `.` 段被规范化丢弃；供 `.worldignore` 与 `assets_manifest` 等声明路径校验。
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  const segments = pathSegments(path)
  return segments !== null && segments.length > 0
}

/**
 * 候选包文件路径是否安全（严格口径）：逐段拒绝空段 / `.` / `..` / Windows 非法字符 /
 * 尾随点空格 / Windows 保留设备名，并限长。供 `validate_package` 的候选树落盘前校验。
 */
export function isSafePackageFilePath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_RELATIVE_PATH_LENGTH) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.includes('\\') || path.includes('\u0000')) return false
  if (/^[A-Za-z]:/.test(path)) return false
  return path.split('/').every((segment) => {
    if (segment.length === 0 || segment === '.' || segment === '..') return false
    if (!SAFE_SEGMENT.test(segment)) return false
    if (segment.endsWith('.') || segment.endsWith(' ')) return false
    return !WINDOWS_RESERVED_NAMES.has(segment.toLowerCase())
  })
}
