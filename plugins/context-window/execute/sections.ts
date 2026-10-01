// 分节 token 明细：把已装配消息按用途归类，输出可调试的每节计数。
// 分类与 manifest 的 11 个分节键一一对应；消息 token = parts + 工具调用 + 推理，三部分分别归位。

import { isKnownSource } from './types.ts'
import type { CanonicalMessage, SectionTokens } from './types.ts'

function emptySections(): SectionTokens {
  return {
    system: 0,
    tools: 0,
    rules: 0,
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
 * 归类：工具结果（role=tool）→ `tool_results`；技能 / 风格 → `rules`；
 * 历史正文 → `history_text`；提示语（`hint`）→ `hints`；调用与推理单独成节。
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
    // 外部来源按自报稳定性归节：stable 计入 system，dynamic 计入 history_text。
    if (!isKnownSource(message.source)) {
      sections[message.stability === 'stable' ? 'system' : 'history_text'] += partsTokens
      continue
    }
    switch (message.source) {
      case 'prompt':
        sections.system += partsTokens
        break
      case 'tools':
        sections.tools += partsTokens
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
