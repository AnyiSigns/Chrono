// 源码 watcher 的触发过滤（纯函数）：把「包内相对路径」映射为「是否参与打包」。
// 与 `assembly/source.ts` 的打包排除同口径（通用排除 + `.worldignore` 前缀匹配）。
// 这一层是防死循环的关键：`dist/` 等构建产物若不过滤，一次构建写产物就会触发下一次换代，
// 换代又重建产物，形成「构建 → 产物变 → 再换代 → 再构建」的无限循环。

import {
  MATERIALIZE_MARKER,
  SOURCE_EXCLUDED_NAMES,
  WORLDIGNORE_FILE,
  isIgnored,
} from '../assembly/source.ts'

/**
 * 拆路径段：同时接受 `/` 与 `\`（Windows 的 `fs.watch` recursive 事件文件名可能带反斜杠），
 * 丢弃空段与 `.`。返回空数组表示无法定位（调用方保守处理）。
 */
export function watchPathSegments(filename: string): string[] {
  return filename.split(/[\\/]/).filter((segment) => segment.length > 0 && segment !== '.')
}

/**
 * 该包内相对路径的变动是否需要触发重新入世。
 * 判定顺序与打包一致：任一目录段命中通用排除 → 整棵子树不入世，不触发；
 * 命中 `.worldignore` 声明项 → 不触发；`.chrono-materialized` 宿主标记恒不入源码树 → 不触发。
 * `.worldignore` 自身变动 → 触发：排除规则变了，打包结果可能随之改变（内容真没变则提交前会判 unchanged）。
 */
export function isPackedChange(segments: string[], patterns: string[][]): boolean {
  if (segments.length === 0) return false
  if (segments.some((segment) => SOURCE_EXCLUDED_NAMES.has(segment))) return false
  if (segments.includes(MATERIALIZE_MARKER)) return false
  if (segments[segments.length - 1] === WORLDIGNORE_FILE) return true
  return !isIgnored(segments, patterns)
}
