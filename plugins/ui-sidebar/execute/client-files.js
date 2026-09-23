// 客户端半边字节读取：只接受包内相对 `.js` 路径，拒绝绝对路径 / 盘符 / 反斜杠 / `..` / 空段。
// 基址 = `execute/web/`（产物落 `execute/web/dist/entry.js`）；显式 `execute/web/` / `web/` 前缀会剥掉。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 客户端半边根目录（`execute/web/`）。 */
export const CLIENT_WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url))

const WIN_DRIVE_RE = /^[A-Za-z]:/

/** 路径形态校验：包内相对 `.js`，禁绝对 / 盘符 / 反斜杠 / NUL / `..` / 空段 / `.` 段。 */
export function isSafeClientPath(path) {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.includes('\\') || path.includes('\u0000')) return false
  if (path.startsWith('/') || WIN_DRIVE_RE.test(path)) return false
  const segments = path.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false
  return path.endsWith('.js')
}

/** 归一为相对客户端半边根的路径（兼容显式 `execute/web/` / `web/` 前缀）。 */
export function clientRelPath(path) {
  if (path.startsWith('execute/web/')) return path.slice('execute/web/'.length)
  if (path.startsWith('web/')) return path.slice('web/'.length)
  return path
}

/** 读一个客户端半边文件：形态非法 / 越界 / 缺失均结构化失败，不抛错。 */
export function readClientFile(baseDir, path) {
  if (!isSafeClientPath(path)) return { ok: false, code: 'bad_path' }
  const root = resolve(baseDir)
  const target = resolve(root, ...clientRelPath(path).split('/'))
  if (target !== root && !target.startsWith(root + sep)) return { ok: false, code: 'bad_path' }
  try {
    return { ok: true, path, text: readFileSync(target, 'utf8') }
  } catch {
    return { ok: false, code: 'not_found' }
  }
}
