// 回合收口视图模型（纯函数）：把回合终态事件携带的预算收口原因映射成一行说明。
// 常规「编排进度」行已移到输入卡下方状态栏（ui-composer）；此处只剩预算收口说明。

import { formatText } from './messages.ts'

/** 预算收口说明文案；无 `stop_reason` 回 null。 */
export function stopReasonText(reason: unknown): string | null {
  return typeof reason === 'string' && reason.length > 0 ? formatText('chat_stop_reason', { reason }) : null
}
