// 表格导出 / 复制的纯格式化（二维文本矩阵进、字符串出）：无 DOM、无副作用，可在 node --test 直接单测。
// 三种目标形态：TSV（粘进表格软件自动分列）、CSV（RFC4180 引号转义，换行 CRLF）、GFM 管道表格（回贴 markdown）。

/** TSV：单元格以制表符分隔，行以换行分隔。 */
export function tableToTsv(rows: string[][]): string {
  return rows.map((row) => row.join('\t')).join('\n')
}

/** CSV 单元格转义：含逗号 / 引号 / 换行时加引号，内部引号翻倍。 */
function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** CSV：单元格逗号分隔、行 CRLF 分隔（调用方按需前置 UTF-8 BOM）。 */
export function tableToCsv(rows: string[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
}

/** GFM 管道表格：首行作表头，次行是分隔行；单元格内的 `|` 转义。 */
export function tableToMarkdown(rows: string[][]): string {
  if (rows.length === 0) return ''
  const escapeCell = (value: string): string => value.replace(/\|/g, '\\|')
  const line = (row: string[]): string => `| ${row.map(escapeCell).join(' | ')} |`
  const separator = `| ${rows[0].map(() => '---').join(' | ')} |`
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join('\n')
}
