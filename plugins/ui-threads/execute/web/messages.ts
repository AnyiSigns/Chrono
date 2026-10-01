// 文案取用：共享表（壳 `/assets/messages.v1.json`）优先，未登记码回落到线程顶栏 `UI_TEXT`。
// 解析 / 取用 / 拉取实现由共享 UI 套件提供；纯模块：无 DOM、无 react import。

import { createMessages } from '@chrono/ui-kit/messages'

export type { MessageEntry, MessageTable } from '@chrono/ui-kit/messages'

/** 本插件界面文案（单一来源；按码取用）。 */
export const UI_TEXT: { [code: string]: string } = {
  threads_region: '线程顶栏',
  thread_label_main: '对话',
  thread_label_subagent: '子代理',
  thread_label_group: '群聊',
  thread_label_workflow: '工作流',
  threads_todo_progress: '{done}/{total} 个待办已完成',
  threads_unread: '未读 {count}',
  threads_loading: '读取中…',
  threads_loading_more: '仍在读取…',
  threads_retry: '重试',
  threads_status_running: '运行中',
  threads_status_pending: '待审批',
  threads_status_done: '完成',
  threads_status_failed: '失败',
}

const messages = createMessages(UI_TEXT)

export const FALLBACK_MESSAGES = messages.FALLBACK_MESSAGES
export const UNKNOWN_CODE = 'unknown'
export const parseMessages = messages.parseMessages
export const lookupMessage = messages.lookupMessage
export const messageText = messages.messageText
export const formatText = messages.formatText
export const loadMessages = messages.loadMessages
