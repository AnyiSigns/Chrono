// 客户端半边产物只读交付的共用实现：`<id>.client.read` 的参数校验与包内读回。
// 产物被 `.worldignore` 排除，`host.source.read` 读不到，故由插件进程读自己的包内文件回字节。
// 路径穿越防护 fail-closed：只接受包内相对 `.js`，拒绝对路径 / 盘符 / 反斜杠 / `..` / 空段 / NUL。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const WIN_DRIVE_RE = /^[A-Za-z]:/

/** 包内相对 `.js` 路径判定（纯函数，供命令与单测共用）。 */
export function isSafeClientPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.includes('\\') || path.includes('\u0000')) return false
  if (path.startsWith('/') || WIN_DRIVE_RE.test(path)) return false
  if (!path.endsWith('.js')) return false
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** 归一为相对客户端半边根的路径（兼容显式 `execute/web/` / `web/` 前缀）。 */
export function clientRelPath(path: string): string {
  if (path.startsWith('execute/web/')) return path.slice('execute/web/'.length)
  if (path.startsWith('web/')) return path.slice('web/'.length)
  return path
}

/** 把安全相对路径解析为 `webDir` 下的绝对路径；非法或越界返回 null。 */
export function resolveClientPath(webDir: string, path: unknown): string | null {
  if (!isSafeClientPath(path)) return null
  const base = resolve(webDir)
  const full = resolve(base, path)
  if (full !== base && !full.startsWith(base + sep)) return null
  return full
}

/** 读回包内客户端半边文本；非法路径 / 读失败返回 null。 */
export function readClientFileText(webDir: string, path: unknown): string | null {
  const full = resolveClientPath(webDir, path)
  if (full === null) return null
  try {
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}

/** 读回包内客户端半边文本并保留请求路径；非法 / 越界 / 缺失返回 null。 */
export function readClientFileInfo(webDir: string, path: unknown): { path: string; text: string } | null {
  const full = resolveClientPath(webDir, path)
  if (full === null) return null
  try {
    return { path, text: readFileSync(full, 'utf8') }
  } catch {
    return null
  }
}

/** 读回并结构化收口：形态非法 / 越界回 `bad_path`，缺失回 `not_found`，不抛错。 */
export function readClientFileResult(
  baseDir: string,
  path: unknown,
): { ok: true; path: string; text: string } | { ok: false; code: 'bad_path' | 'not_found' } {
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
