// 从正文里抽取与查询最相关的段落（highlights）：比整页正文省 token，比 snippet 有信息量。
// 纯字符串处理、无随机 / 无时间，同输入同输出（确定性、可回放）。

const MAX_PASSAGES = 3
const MIN_BLOCK_CHARS = 40

/** 查询切词：长度 ≥2 的字母 / 数字串，去重保序。 */
function queryTerms(query: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of query.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []) {
    if (seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/**
 * 抽与 query 最相关的段落：按查询词命中次数计分，取前 `MAX_PASSAGES` 段（缺命中回退首段），
 * 按原文顺序拼接，累计不超过 `budget` 字符。空正文回空数组。
 */
export function extractPassages(text: string, query: string, budget: number): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0 || budget <= 0) return []
  const blocks = trimmed
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block.length >= MIN_BLOCK_CHARS)
  if (blocks.length === 0) return [trimmed.slice(0, budget)]

  const terms = queryTerms(query)
  const scored = blocks.map((block, index) => {
    const lower = block.toLowerCase()
    let score = 0
    for (const term of terms) {
      let at = lower.indexOf(term)
      while (at !== -1) {
        score += 1
        at = lower.indexOf(term, at + term.length)
      }
    }
    return { index, block, score }
  })
  const hit = scored.filter((entry) => entry.score > 0)
  const chosen = (hit.length > 0 ? hit : scored.slice(0, 1))
    .sort((left, right) => (left.score !== right.score ? right.score - left.score : left.index - right.index))
    .slice(0, MAX_PASSAGES)
    .sort((left, right) => left.index - right.index)

  const out: string[] = []
  let used = 0
  for (const entry of chosen) {
    if (used >= budget) break
    const room = budget - used
    out.push(entry.block.length > room ? entry.block.slice(0, room) : entry.block)
    used += Math.min(entry.block.length, room)
  }
  return out
}
