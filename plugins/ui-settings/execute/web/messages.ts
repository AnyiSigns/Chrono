// 文案取用：共享表（壳 `/assets/messages.v1.json`）优先，未登记码回落到本插件最小 `UI_TEXT`。
// 解析 / 取用 / 拉取实现由共享 UI 套件提供，本文件只承载本插件界面文案。

import { createMessages } from '@chrono/ui-kit/messages'

export type { MessageEntry, MessageTable } from '@chrono/ui-kit/messages'

/** 共享表不可用 / 未登记时的最小骨架兜底（不承载业务文案；新增文案进共享表，勿加键）。 */
export const UI_TEXT: Record<string, string> = {
  settings_title: '设置',
  settings_close: '关闭设置',
  settings_retry: '重试',
  settings_empty: '暂无内容',
  settings_loading_more: '仍在读取…',
  settings_dependency_missing: '依赖未就绪',
  settings_dependency_missing_hint: '所需身份尚未就绪，相关视图暂不可用。',
  settings_saved: '已保存',
}

const messages = createMessages(UI_TEXT)

export const FALLBACK_MESSAGES = messages.FALLBACK_MESSAGES
export const UNKNOWN_CODE = 'unknown'
export const parseMessages = messages.parseMessages
export const lookupMessage = messages.lookupMessage
export const messageText = messages.messageText
export const formatText = messages.formatText
export const loadMessages = messages.loadMessages
