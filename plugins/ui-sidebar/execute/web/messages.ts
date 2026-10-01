// 文案取用：共享表（壳 `/assets/messages.v1.json`）优先，未登记码回落到侧栏 `UI_TEXT`。
// 解析 / 取用 / 拉取实现由共享 UI 套件提供，本文件只承载本插件界面文案（唯一允许出现中文的 web 模块）。

import { createMessages } from '@chrono/ui-kit/messages'

export type { MessageEntry, MessageTable } from '@chrono/ui-kit/messages'

/** 侧栏界面文案（共享表未登记时的本地兜底；界面标签集中于此，勿散落到其它 web 模块）。 */
export const UI_TEXT: Record<string, string> = {
  sidebar_add_workspace: '添加工作目录',
  sidebar_new_conversation: '在此工作区新建对话',
  sidebar_settings: '设置',
  sidebar_expand: '展开',
  sidebar_collapse: '收缩',
  sidebar_search_placeholder: '搜索会话',
  sidebar_no_match: '无匹配',
  sidebar_empty_title: '还没有会话',
  sidebar_empty_hint: '添加工作目录后即可开始。',
  sidebar_open_in_explorer: '在文件管理器中打开',
  sidebar_remove_workspace: '移除工作区',
  sidebar_rename: '重命名',
  sidebar_export: '导出',
  sidebar_export_md: '导出 markdown',
  sidebar_export_json: '导出 JSON',
  sidebar_branch: '分支',
  sidebar_delete: '删除',
  sidebar_confirm_delete: '确认删除？',
  sidebar_confirm: '确认',
  sidebar_cancel: '取消',
  sidebar_undo: '撤销',
  sidebar_deleted: '已删除',
  sidebar_exported: '已导出',
  sidebar_export_failed: '导出失败',
  sidebar_exporting: '导出中…',
  sidebar_waiting_picker: '等待选择…',
  sidebar_picker_unavailable: '系统选择器不可用',
  sidebar_picker_unavailable_hint: '可用 CLI 或启动参数指定目录。',
  sidebar_directory_missing: '目录不存在',
  sidebar_terminate: '终止',
  sidebar_confirm_terminate: '确认终止？',
  sidebar_running: '运行中',
  sidebar_pending: '待审批',
  sidebar_failed: '失败',
  sidebar_unread: '未读',
  sidebar_dependency_missing: '依赖未就绪',
  sidebar_retry: '重试',
  sidebar_loading_more: '仍在读取…',
  sidebar_product: 'Chrono',
  sidebar_unread_count: '未读 {count}',
  sidebar_rail_label: '会话列表',
  sidebar_ungrouped: '未分组',
  sidebar_expand_unavailable: '窗口过窄，无法展开',
  sidebar_time_now: '刚刚',
  sidebar_time_minutes: '{n} 分钟前',
  sidebar_time_hours: '{n} 小时前',
  sidebar_time_today: '今天',
  sidebar_time_yesterday: '昨天',
  sidebar_time_days: '{n} 天前',
  sidebar_time_older: '更早',
}

const messages = createMessages(UI_TEXT)

export const FALLBACK_MESSAGES = messages.FALLBACK_MESSAGES
export const UNKNOWN_CODE = 'unknown'
export const parseMessages = messages.parseMessages
export const lookupMessage = messages.lookupMessage
export const messageText = messages.messageText
export const formatText = messages.formatText
export const loadMessages = messages.loadMessages
