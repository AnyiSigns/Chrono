// 文案取用：共享表（壳 `/assets/messages.v1.json`）优先，未登记码回落到本插件 `UI_TEXT`。
// 解析 / 取用 / 拉取实现由共享 UI 套件提供，本文件只承载本插件界面文案。

import { createMessages } from '@chrono/ui-kit/messages'

export type { MessageEntry, MessageTable } from '@chrono/ui-kit/messages'

/** 本插件界面文案（单一来源；按码取用，便于日后迁入共享表）。 */
export const UI_TEXT: { [code: string]: string } = {
  composer_placeholder: '输入消息…（Enter 发送）',
  composer_send: '发送',
  composer_stop: '终止',
  composer_attach: '添加附件',
  composer_attach_failed: '附件读取失败',
  composer_remove_attachment: '移除附件',
  composer_model: '模型',
  composer_reasoning: '推理强度',
  composer_permission: '权限',
  composer_permission_auto: '全过',
  composer_permission_severe: '工作区读写',
  composer_permission_review: '工作区只读',
  composer_permission_deny: '全部拒绝',
  composer_permission_auto_desc: '全部放行',
  composer_permission_severe_desc: '工作区读写；工作区外或危险操作弹卡',
  composer_permission_review_desc: '只读工作区',
  composer_permission_deny_desc: '全部拒绝',
  composer_no_model: '未配置模型',
  composer_need_workspace: '请先添加工作目录',
  composer_need_model: '请先选择模型',
  composer_config_loading: '配置读取中…',
  composer_config_loading_more: '仍在读取…',
  composer_config_failed: '配置读取失败。重试可再试一次。',
  composer_config_offline: '宿主不可达，配置暂不可用。',
  composer_reasoning_fetching: '获取中…',
  composer_reasoning_failed: '档位读取失败',
  composer_reasoning_on: '开',
  composer_reasoning_off: '关',
  composer_retry: '重试',
  composer_pending: '待发 {count}',
  composer_pending_title: '待发消息',
  composer_pending_remove: '移除',
  composer_context: '上下文 {used} / {budget}',
  composer_context_full: '上下文已满 · {used} / {budget}',
  composer_orchestration_progress: '第 {round} 轮',
  composer_model_input: '模型输入 {count}',
  composer_model_output: '模型输出 {count}',
  composer_model_cache: '缓存命中 {rate}',
  composer_source_prompt: '系统提示',
  composer_source_tools: '工具',
  composer_source_input: '用户输入',
  composer_source_skill: '技能',
  composer_source_history: '历史',
  composer_source_style: '风格',
  composer_trimmed: '被裁剪 {count} 项',
  composer_trimmed_reason: '原因：{reason}',
  composer_attachment: '附件 {count}',
  composer_more_chip: '+{count}',
  composer_open_settings: '前往设置',
  composer_outcome_detail: '（{code} · 归因 {attribution}）',
  loop_unavailable: '模型服务不可达，回合未能开始。稍后重试。',
  owner_unavailable: '运行记录服务不可用，回合未能开始。稍后重试。',
  turn_busy: '本会话已有回合在跑，消息已保留，稍后重试。',
  no_plan: '编排没有产出可执行的计划。请重试。',
  contract_violation: '回合结束但没有结局记录（契约违例）。请重试或反馈。',
  transport_refused: '传输层拒绝了这次回合。稍后重试。',
  empty_slot: '输入槽为空，回合未能开始。请重新输入。',
  model_not_configured: '尚未配置模型。前往设置选择厂商与模型。',
  interrupted: '回合已中断。',
  cancelled: '回合已取消。',
}

const messages = createMessages(UI_TEXT)

export const FALLBACK_MESSAGES = messages.FALLBACK_MESSAGES
export const UNKNOWN_CODE = 'unknown'
export const parseMessages = messages.parseMessages
export const lookupMessage = messages.lookupMessage
export const messageText = messages.messageText
export const formatText = messages.formatText
export const loadMessages = messages.loadMessages
