// 文案取用：共享表（壳 `/assets/messages.v1.json`）优先，未登记码回落到审批停靠带 `UI_TEXT`。
// 解析 / 取用 / 拉取实现由共享 UI 套件提供；纯模块：不触 DOM、不 import react。

import { createMessages } from '@chrono/ui-kit/messages'

export type { MessageEntry, MessageTable } from '@chrono/ui-kit/messages'

/** 本插件界面文案（单一来源；按码取用，便于日后迁入共享表）。 */
export const UI_TEXT: Record<string, string> = {
  approval_dock_label: '审批停靠带',
  approval_waiting: '待审批 {count}',
  approval_waited: '已等待 {time}',
  approval_expired_label: '已超时',
  approval_all_approve: '全部批准',
  approval_all_deny: '全部拒绝',
  approval_confirm_approve: '确认批准 {count} 项？',
  approval_confirm_deny: '确认拒绝并终止本回合？',
  approval_approve: '批准',
  approval_deny: '拒绝',
  approval_deny_hint: '拒绝并终止本回合',
  approval_all_deny_hint: '全部拒绝 = 放弃本回合',
  approval_submitting: '提交中…',
  approval_failed: '裁决提交失败。重试可再试一次。',
  approval_load_failed: '读取待审批队列失败。重试可再试一次。',
  approval_offline: '宿主不可达，审批暂不可用。重试可恢复。',
  approval_loading_more: '仍在读取…',
  approval_retry: '重试',
  approval_orchestration_change: '编排变更',
  approval_plugin_write: '插件写入',
  approval_tool_call: '工具调用',
  approval_validate_ok: 'validate ✓',
  approval_validate_failed: 'validate ✗',
  approval_isolation_risk: '失败将隔离该插件分支，需回滚上一世代',
  approval_shadow_title: '影子回放',
  approval_shadow_rounds: '历史 {count} 回合，零模型调用',
  approval_shadow_token: 'token',
  approval_shadow_steps: '步数',
  approval_shadow_tool_failure: '工具失败',
  approval_shadow_approval: '审批触发',
  approval_graph_diff: '图 diff',
  approval_expand: '展开',
  approval_collapse: '收起',
  approval_expand_all: '展开全部 {count} 项',
  approval_collapse_all: '收起为堆叠',
  approval_empty: '暂无待审批项',
  approval_queue_full: '审批队列已满。先处理现有条目。',
  approval_dependency_missing: '依赖未就绪',
  approval_dependency_missing_hint: '审批服务尚未就绪，停靠带暂不可用。',
  approval_loading: '读取中…',
  approval_status_approved: '已批准',
  approval_status_denied: '已拒绝',
  approval_status_expired: '已超时',
  approval_status_pending: '待审批',
  approval_files_count: '{count} 个文件',
  approval_args_summary: '参数摘要',
  approval_no_args: '无参数摘要',
  approval_nodes_edges: '{nodes} 节点 / {edges} 边',
}

const messages = createMessages(UI_TEXT)

export const FALLBACK_MESSAGES = messages.FALLBACK_MESSAGES
export const UNKNOWN_CODE = 'unknown'
export const parseMessages = messages.parseMessages
export const lookupMessage = messages.lookupMessage
export const messageText = messages.messageText
export const formatText = messages.formatText
export const loadMessages = messages.loadMessages
