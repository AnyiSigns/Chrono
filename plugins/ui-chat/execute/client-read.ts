// 客户端半边产物只读交付：`ui-chat.client.read` 的参数校验与包内读回。
// 产物被 `.worldignore` 排除，`host.source.read` 读不到，故由插件进程读自己的包内文件回字节。
// 路径穿越防护：只接受包内相对 `.js` 路径，拒绝对路径 / 盘符 / 反斜杠 / `..` / 空段。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/** 包内相对 `.js` 路径判定（纯函数，供命令与单测共用）。 */
export function isSafeClientPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0) return false
  if (path.includes('\\') || path.includes('\u0000')) return false
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false
  if (!path.endsWith('.js')) return false
  return path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
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
export function readClientFile(webDir: string, path: unknown): string | null {
  const full = resolveClientPath(webDir, path)
  if (full === null) return null
  try {
    return readFileSync(full, 'utf8')
  } catch {
    return null
  }
}
