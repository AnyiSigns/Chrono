// 分节 token 明细：把已装配消息按用途归类，输出可调试的每节计数。
// 分类与 manifest 的 11 个分节键一一对应；消息 token = parts + 工具调用 + 推理，三部分分别归位。

import type { CanonicalMessage, SectionTokens } from './types.ts'

function emptySections(): SectionTokens {
  return {
    system: 0,
    tools: 0,
    rules: 0,
    l2: 0,
    checkpoint: 0,
    history_text: 0,
    tool_calls: 0,
    tool_results: 0,
    reasoning: 0,
    input: 0,
    hints: 0,
  }
}

/**
 * 计算分节 token。
 * 归类：工具结果（role=tool）→ `tool_results`；技能 / 风格 → `rules`；L1 摘要 → `checkpoint`；
 * 历史 / 召回正文 → `history_text`；提示语（`hint`）→ `hints`；调用与推理单独成节。
 */
export function computeSections(messages: CanonicalMessage[]): SectionTokens {
  const sections = emptySections()
  for (const message of messages) {
    const partsTokens = Math.max(0, message.tokens - message.toolCallTokens - message.reasoningTokens)
    sections.tool_calls += message.toolCallTokens
    sections.reasoning += message.reasoningTokens
    if (message.hint === true) {
      sections.hints += partsTokens
      continue
    }
    if (message.role === 'tool') {
      sections.tool_results += partsTokens
      continue
    }
    switch (message.source) {
      case 'prompt':
        sections.system += partsTokens
        break
      case 'tools':
        sections.tools += partsTokens
        break
      case 'l2':
        sections.l2 += partsTokens
        break
      case 'l1':
        sections.checkpoint += partsTokens
        break
      case 'skill':
      case 'style':
        sections.rules += partsTokens
        break
      case 'input':
        sections.input += partsTokens
        break
      default:
        sections.history_text += partsTokens
        break
    }
  }
  return sections
}
