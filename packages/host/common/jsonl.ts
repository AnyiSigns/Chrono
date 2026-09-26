// 容错 JSONL 逐行读与撕裂尾守卫：journal 与审计侧存共用同一份字节扫描口径。
// 追加是「整段一次写」，崩溃只可能留下**最后一条**非空行的半截（无换行结尾）。

import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs'

export interface JsonlRead<T> {
  items: T[]
  /** 末行撕裂（无换行的半截）被丢弃：持锁写方须先截断到 `validBytes` 再 append。 */
  truncated: boolean
  /** 有效前缀的字节长度（含末条完整行的换行）；无截断时等于文件大小。 */
  validBytes: number
}

export interface JsonlReadOptions<T> {
  /** 解析一行；解析失败抛错。空行在扫描层被跳过，不会交给它。 */
  parse: (line: string) => T
  /**
   * 带换行的坏行处置：true = 上抛（完整性判定不得静默丢条目）；
   * false = 跳过并推进有效前缀（旁路侧存 fail-open，不砖化）。
   * 末段无换行的坏行无论 strict 与否都只作撕裂尾丢弃。
   */
  strict: boolean
}

/**
 * 容错读一个 JSONL 文件：缺文件视为空；末段无换行且解析失败视为撕裂尾丢弃并回报有效前缀字节数。
 * 带换行的坏行按 `strict` 上抛或跳过；中间行同理。
 */
export function readJsonlFile<T>(file: string, options: JsonlReadOptions<T>): JsonlRead<T> {
  if (!existsSync(file)) return { items: [], truncated: false, validBytes: 0 }
  const bytes = readFileSync(file)
  const items: T[] = []
  let validBytes = 0
  let start = 0
  while (start < bytes.length) {
    const newline = bytes.indexOf(0x0a, start)
    const lineEnd = newline === -1 ? bytes.length : newline + 1
    const line = bytes.subarray(start, newline === -1 ? bytes.length : newline).toString('utf8')
    if (line.length === 0) {
      validBytes = lineEnd
      start = lineEnd
      continue
    }
    try {
      items.push(options.parse(line))
      validBytes = lineEnd
    } catch (err) {
      if (newline === -1) return { items, truncated: true, validBytes }
      if (options.strict) throw err
      // 带换行的坏行：跳过，但推进有效前缀（不反复截断）
      validBytes = lineEnd
    }
    start = lineEnd
  }
  return { items, truncated: false, validBytes }
}

/**
 * 非空文件末字节是否为换行；缺文件 / 空文件返回 true（可安全追加）。
 * 追加前守卫共用：非换行结尾说明上一条是撕裂尾，直接追加会把新条目粘在残行上。
 */
export function endsWithNewline(file: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    if (size === 0) return true
    const tail = Buffer.alloc(1)
    readSync(fd, tail, 0, 1, size - 1)
    return tail[0] === 0x0a
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw err
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // 已关闭
      }
    }
  }
}
