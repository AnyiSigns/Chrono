// 工具结果摘要（digest）：随成功结果自带，供上下文老化直接渲染，无需装配器认识工具语义。
// 只放确定、有界的展示字段：命令、退出码、stdout 尾部（限行再限字符）；不含时间、不含完整输出。

import type { Rec } from './types.ts'

/** 尾部保留行数。 */
const TAIL_LINES = 20
/** 尾部保留字符上限（单行极长时的二次兜底）。 */
const TAIL_CHARS = 2000

/** stdout 的确定尾部：取最后若干行，再按字符上限从末尾截断；空输出回空串。 */
export function stdoutTail(stdout: string): string {
  if (stdout.length === 0) return ''
  const lines = stdout.split(/\r?\n/)
  const tail = lines.slice(Math.max(0, lines.length - TAIL_LINES)).join('\n')
  return tail.length > TAIL_CHARS ? tail.slice(tail.length - TAIL_CHARS) : tail
}

/** 命令执行摘要：命令、退出码、stdout 尾部。 */
export function shellDigest(cmd: string, exit: number | null, stdout: string): Rec {
  return { cmd, exit, stdout_tail: stdoutTail(stdout) }
}
