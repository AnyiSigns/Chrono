// 编排进度视图模型（纯函数）：把回合事件携带的图内进度映射成一行紧凑状态文案。
// `node_index` / `contract_id` 只有在图定义可解析时才能映射成人话节点名；图定义不在显示投影里，
// 故按契约 id 回落——契约 id（如 `tool.dispatch`）本身即节点动作的可读标识。文案一律走 message key。

import { formatText } from './messages.ts'

function isRec(value: unknown): value is { [key: string]: any } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 进度行文案：`编排：<node> · 第 <iter+1> 轮`；无可用进度回 null（不渲染空行）。
 * `node` 优先契约 id，缺失才回落 `节点 <node_index+1>`；`iter` 缺失则只给节点名。
 */
export function progressText(progress: unknown): string | null {
  if (!isRec(progress)) return null
  const contract =
    typeof progress.contract_id === 'string' && progress.contract_id.length > 0 ? progress.contract_id : null
  const nodeIndex =
    typeof progress.node_index === 'number' && Number.isFinite(progress.node_index) ? progress.node_index : null
  const node = contract ?? (nodeIndex !== null ? formatText('chat_node_name', { index: nodeIndex + 1 }) : null)
  if (node === null) return null
  const iter = typeof progress.iter === 'number' && Number.isFinite(progress.iter) ? progress.iter : null
  return iter === null
    ? formatText('chat_orchestration_node', { node })
    : formatText('chat_orchestration_progress', { node, round: iter + 1 })
}

/** 预算收口说明文案；无 `stop_reason` 回 null。 */
export function stopReasonText(reason: unknown): string | null {
  return typeof reason === 'string' && reason.length > 0 ? formatText('chat_stop_reason', { reason }) : null
}
