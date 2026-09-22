// 本插件静态资源读取：
// - `dist/` 是构建产物（esbuild 打包 `src/app.jsx`），以模块位置定位、与 cwd 无关；
// - `index.html` 是源码外壳，随源码入世，直接按模块位置读取。
// 产物名走白名单，杜绝路径穿越；缓存一律禁用以免启发式缓存让改动长期不生效。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 允许投递的产物名（扁平、小写、连字符 / 点）。 */
export const DIST_FILE_RE = /^[a-z0-9.-]+\.js$/

/** 构建产物目录绝对路径（物化目录内的 `dist/`）。 */
export function distDirOf() {
  return fileURLToPath(new URL('../dist/', import.meta.url))
}

/** 外壳 HTML 绝对路径（随源码入世的 `execute/index.html`）。 */
export function indexHtmlPath() {
  return fileURLToPath(new URL('./index.html', import.meta.url))
}

/** 读一个产物文件；名字非法或读取失败返回 null（调用方回 404）。 */
export function readDistFile(distDir, name) {
  if (!DIST_FILE_RE.test(name)) return null
  try {
    return readFileSync(join(distDir, name))
  } catch {
    return null
  }
}
