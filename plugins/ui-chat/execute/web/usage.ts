// token 用量脚注（纯函数）：读消息 def 的 `meta.usage`；无则不显示；模型名不进脚注。

/** 计数格式（§16.10）：≥1000 保留 1 位小数用 `k`，≥1M 用 `M`。 */
export function formatCount(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return ''
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

function firstNumber(record: { [key: string]: any }, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

/** 从 `meta.usage` 取总 token 数：兼容 total / input+output 两类方言。 */
export function usageTotal(usage: unknown): number | null {
  if (typeof usage === 'number') return Number.isFinite(usage) ? usage : null
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return null
  const record = usage as { [key: string]: any }
  const total = firstNumber(record, ['total_tokens', 'totalTokens', 'total'])
  if (total !== null) return total
  const input = firstNumber(record, ['prompt_tokens', 'input_tokens', 'inputTokens'])
  const output = firstNumber(record, ['completion_tokens', 'output_tokens', 'outputTokens'])
  if (input === null && output === null) return null
  return (input ?? 0) + (output ?? 0)
}

/** 消息 def → 脚注用量文案；无 `meta.usage` 返回 null。 */
export function usageText(def: any): string | null {
  if (typeof def !== 'object' || def === null) return null
  const meta = def.meta
  if (typeof meta !== 'object' || meta === null) return null
  const total = usageTotal(meta.usage)
  if (total === null) return null
  return `${formatCount(total)} tokens`
}
