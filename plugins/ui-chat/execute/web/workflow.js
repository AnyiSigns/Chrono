// 工作流步骤卡视图模型（纯函数）：当前步骤 + 第 i/N 步 + 状态 + 只读节点列表。
// 数据来自会话 body 的 `workflow`（图哈希 / node_index / iter）与 `workflow.step` 事件；不渲染消息气泡。

import { formatText, UI_TEXT } from './messages.js'

function isRec(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STATUSES = new Set(['running', 'success', 'failed', 'skipped', 'waiting', 'pending'])

function normalizeStatus(value, fallback = 'pending') {
  return typeof value === 'string' && STATUSES.has(value) ? value : fallback
}

function nodeList(graphDef) {
  if (!isRec(graphDef)) return []
  const body = isRec(graphDef.body) ? graphDef.body : graphDef
  const raw = Array.isArray(body.nodes) ? body.nodes : Array.isArray(body.steps) ? body.steps : []
  return raw.map((node, index) => {
    const item = isRec(node) ? node : {}
    return {
      index: typeof item.node_index === 'number' ? item.node_index : index,
      name: typeof item.name === 'string' ? item.name : typeof item.contract === 'string' ? item.contract : formatText('chat_node_name', { index: index + 1 }),
      impl: typeof item.impl === 'string' ? item.impl : typeof item.identity === 'string' ? item.identity : '',
      status: normalizeStatus(item.status),
      rejectCode: typeof item.reject_code === 'string' ? item.reject_code : typeof item.code === 'string' ? item.code : null,
    }
  })
}

/**
 * 工作流步骤卡视图模型。
 * @param {{conversation?: object, graphDef?: object, step?: object}} input
 */
export function workflowViewModel(input) {
  const conversation = isRec(input?.conversation) ? input.conversation : null
  const workflow = conversation !== null && isRec(conversation.workflow) ? conversation.workflow : null
  const step = isRec(input?.step) ? input.step : null
  const nodes = nodeList(input?.graphDef)

  const index =
    step !== null && typeof step.node_index === 'number'
      ? step.node_index
      : workflow !== null && typeof workflow.node_index === 'number'
        ? workflow.node_index
        : 0
  const total = nodes.length > 0 ? nodes.length : step !== null && typeof step.total === 'number' ? step.total : 0
  const currentStatus =
    step !== null && typeof step.status === 'string'
      ? normalizeStatus(step.status)
      : conversation !== null && conversation.status === 'failed'
        ? 'failed'
        : 'running'
  const failedIndex = nodes.findIndex((node) => node.status === 'failed')
  const failed = failedIndex >= 0 ? nodes[failedIndex] : null
  return {
    title:
      (step !== null && typeof step.name === 'string' && step.name) ||
      (nodes[index] !== undefined ? nodes[index].name : '') ||
      (conversation !== null && typeof conversation.title === 'string' ? conversation.title : ''),
    index,
    total,
    status: currentStatus,
    nodes,
    failedIndex,
    rejectCode: failed !== null ? failed.rejectCode : null,
  }
}

/** 状态三重编码的图标名（颜色 + 图标 + 文字，§11 红线 2）。 */
export function statusIcon(status) {
  if (status === 'success') return 'check'
  if (status === 'failed') return 'x'
  if (status === 'waiting' || status === 'pending') return 'alert-triangle'
  if (status === 'skipped') return 'ban'
  return 'gauge'
}

/** 状态文字。 */
export function statusText(status) {
  if (status === 'success') return UI_TEXT.chat_status_success
  if (status === 'failed') return UI_TEXT.chat_status_failed
  if (status === 'waiting') return UI_TEXT.chat_status_waiting
  if (status === 'skipped') return UI_TEXT.chat_status_skipped
  if (status === 'pending') return UI_TEXT.chat_status_pending
  return UI_TEXT.chat_status_running
}
