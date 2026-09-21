// 本插件静态资源读取：`execute/web/` 下的浏览器模块（源码 ESM 直接服务，不自打包）。
// 只允许扁平文件名（`^[a-z0-9-]+\.js$`），杜绝路径穿越；入口 `entry.js` 亦在此列。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包内 `execute/web/` 绝对路径（以模块位置为准，与 cwd 无关）。 */
export function webDirOf(): string {
  return fileURLToPath(new URL('./web/', import.meta.url))
}

/** 允许服务的浏览器模块名（扁平、小写、连字符）。 */
export const WEB_FILE_RE = /^[a-z0-9-]+\.js$/

/** 读一个浏览器模块；名字非法或读取失败返回 null（调用方回 404）。 */
export function readWebFile(webDir: string, name: string): string | null {
  if (!WEB_FILE_RE.test(name)) return null
  try {
    return readFileSync(join(webDir, name), 'utf8')
  } catch {
    return null
  }
}
