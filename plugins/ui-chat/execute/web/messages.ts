// 文案取用：共享表（壳 `/assets/messages.v1.json`）优先，未登记码回落到本插件 `UI_TEXT`。
// 解析 / 取用 / 拉取实现由共享 UI 套件提供，本文件只承载本插件界面文案与带占位符的本地格式化入口。

import { createMessages } from '@chrono/ui-kit/messages'

export type { MessageEntry, MessageTable } from '@chrono/ui-kit/messages'

/** 本插件界面文案（单一来源；按码取用，便于日后迁入共享表）。 */
export const UI_TEXT: { [code: string]: string } = {
  chat_copied: '已复制',
  chat_copy_failed: '复制失败',
  chat_working: '正在工作',
  chat_waiting: '等待审批',
  chat_reasoning: '推理',
  chat_cancelled: '已取消',
  chat_interrupted: '已中断',
  chat_outcome_detail: '（{code} · 归因 {attribution}）',
  cancelled: '回合已取消。',
  interrupted: '回合已中断。',
  contract_violation: '回合结束但没有结局记录（契约违例）。请重试或反馈。',
  transport_refused: '传输层拒绝了这次回合。稍后重试。',
  loop_unavailable: '模型服务不可达，回合未能完成。稍后重试。',
  chat_no_more: '没有更多了',
  chat_new_messages: '以下为新消息',
  chat_expired: '已超时',
  chat_media_failed: '媒体加载失败',
  chat_empty_title: '开始新对话',
  chat_empty_hint: '输入消息开始，或先用 + 添加附件',
  chat_loading: '正在读取…',
  chat_submitting: '提交中…',
  chat_retry: '重试',
  chat_copy: '复制',
  chat_code_expand: '展开',
  chat_code_collapse: '收起',
  chat_export: '导出',
  chat_export_csv: 'CSV',
  chat_export_markdown: 'Markdown',
  chat_exported: '已导出',
  chat_close: '关闭',
  chat_play_video: '播放视频',
  chat_other: '其他',
  chat_other_input: '输入其他答案…',
  chat_ignored: '未作答',
  chat_question_single: '单选',
  chat_question_multiple: '多选',
  chat_submit: '提交',
  chat_next: '下一步',
  chat_prev_question: '上一题',
  chat_next_question: '下一题',
  chat_ignore: '忽略',
  chat_question_progress: '第 {index} / {total} 个问题',
  chat_answer_required: '请先作答',
  chat_system_message: '系统消息',
  chat_error: '错误',
  chat_render_failed: '内容渲染失败',
  chat_file: '文件',
  chat_image: '图片',
  chat_agent: 'agent',
  chat_me: '我',
  chat_subagent: '子代理',
  chat_stop_reason: '编排提前收口（{reason}）',
  chat_subagent_triggered: '{agent} · 由 {parent} 触发',
  chat_exit_code: '退出码 {code}',
  chat_diff_mod: '~ {before} → {after}',
  chat_diff_collapsed: '… 折叠 {count} 行 …',
  chat_answer_sep: '、',
  chat_new_messages_pill: '↓ {count} 条新消息',
  chat_pill_more: '↓',
  chat_today: '今天',
  chat_yesterday: '昨天',
}

const messages = createMessages(UI_TEXT)

export const FALLBACK_MESSAGES = messages.FALLBACK_MESSAGES
export const parseMessages = messages.parseMessages
export const lookupMessage = messages.lookupMessage
export const messageText = messages.messageText
export const loadMessages = messages.loadMessages

/** 取带占位符的本地界面文案模板并代入变量（`{name}` 形式）；无共享表上下文时按本地 `UI_TEXT` 取。 */
export function formatText(code: string, vars?: { [key: string]: unknown } | null): string {
  return messages.formatText(undefined, code, vars ?? undefined)
}
