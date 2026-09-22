// 能力类 `ui-sidebar` 的方法表：只做**投影装配 + 反向调用**，不读投影、不落账、不自取时钟。
// 入口 term 把 `ctx.ids` 投影切片随 args 传入；本服务从中取输入槽（per-thread 键控，缺省 `_main`）
// 与会话 / 工作区 body，经宿主反向调用（`port.call`，见协议文档 §2.4）转给 `session` / `workspace`。
// 依赖服务返回写计划（`$directives`）时原样上提给宿主落账；读命令返回结构化值。

import { BadArgsError, asString, isRecord } from './types.js'
import { externOnly, failure } from './plan.js'

/** 缺省线程键（per-thread 键控：读写只碰本键）。 */
export const MAIN_THREAD = '_main'

/** 线程键：调用帧 `env.thread` 非空字符串，否则 `_main`。 */
export function threadKeyOf(env) {
  return asString(env === null || env === undefined ? undefined : env.thread) ?? MAIN_THREAD
}

/** 投影里某身份的 body；缺失 / 非对象返回 null。 */
export function identityBody(ids, id) {
  if (!isRecord(ids)) return null
  const entry = ids[id]
  if (!isRecord(entry)) return null
  return isRecord(entry['body']) ? entry['body'] : null
}

/** 投影里某身份的 refs；缺失返回空对象。 */
export function identityRefs(ids, id) {
  if (!isRecord(ids)) return {}
  const entry = ids[id]
  if (!isRecord(entry)) return {}
  return isRecord(entry['refs']) ? entry['refs'] : {}
}

/** 输入 body 里本线程的槽体；缺失返回 null。 */
export function slotOf(inputBody, threadId) {
  if (!isRecord(inputBody) || !isRecord(inputBody['slots'])) return null
  return inputBody['slots'][threadId] ?? null
}

/**
 * 会话类命令（new / select / rename / delete / restore）的公共装配：
 * `{session, slots, thread_id, slot}`——会话服务据此判槽 kind、切 current、清本线程槽。
 */
export function assembleSessionArgs(ids, env) {
  const session = identityBody(ids, 'session')
  if (session === null) return { ok: false, code: 'session_missing' }
  const slots = identityBody(ids, 'input')
  if (slots === null) return { ok: false, code: 'input_missing' }
  const threadId = threadKeyOf(env)
  return { ok: true, args: { session, slots, thread_id: threadId, slot: slotOf(slots, threadId) } }
}

/** 分支装配：在会话类公共装配上补源链 `refs`（`session.branch` 需要沿 prev 还原链）。 */
export function assembleBranchArgs(ids, env) {
  const base = assembleSessionArgs(ids, env)
  if (!base.ok) return base
  return { ok: true, args: { ...base.args, refs: identityRefs(ids, 'session') } }
}

/**
 * 工作区写类命令（add / remove）装配：`{body, slots, thread_id, slot}`——
 * `body` = 当前 workspaces body，`slots` = 整份输入 body（缺任一即由依赖服务 `bad_args` 拒绝）。
 */
export function assembleWorkspaceWriteArgs(ids, env) {
  const body = identityBody(ids, 'workspace')
  if (body === null) return { ok: false, code: 'workspace_missing' }
  const slots = identityBody(ids, 'input')
  if (slots === null) return { ok: false, code: 'input_missing' }
  const threadId = threadKeyOf(env)
  return { ok: true, args: { body, slots, thread_id: threadId, slot: slotOf(slots, threadId) } }
}

/** `workspace.list` 装配：把当前 workspaces 列表交给依赖服务逐项 stat 标注 `missing`。 */
export function assembleWorkspaceListArgs(ids) {
  const body = identityBody(ids, 'workspace')
  const workspaces = body !== null && Array.isArray(body['workspaces']) ? body['workspaces'] : []
  return { workspaces }
}

/** `workspace.reveal` 装配：只取 id 与随 args 传入的列表（依赖服务按 id 解析 path，不信任裸路径）。 */
export function assembleRevealArgs(args) {
  if (!isRecord(args)) throw new BadArgsError('workspace required')
  const workspace = asString(args['workspace'])
  if (workspace === null) throw new BadArgsError('workspace required')
  const workspaces = Array.isArray(args['workspaces']) ? args['workspaces'] : []
  return { workspace, workspaces }
}

/** 反向调用并返回依赖服务的写计划（原样上提给宿主落账）。 */
async function callPlan(caller, port, method, args) {
  const outcome = await caller.call(port, method, args)
  if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
  return outcome.value
}

/** 反向调用并返回结构化值（读命令 / 纯动作，外包一条 extern 便于命令面取值）。 */
async function callValue(caller, port, method, args) {
  const outcome = await caller.call(port, method, args)
  if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
  return externOnly(outcome.value)
}

/** 装配失败时的统一收口：只回 extern 错误，不构造写计划。 */
function assemblyFailure(result) {
  return externOnly(failure(result.code, result.code))
}

/** 构造方法表；`deps.session` / `deps.workspace` 是反向调用通道（单测注入假端口）。 */
export function createHandlers(deps) {
  /** 会话类命令：装配后反向调 `session` 对应方法。 */
  const sessionCommand = (method, assemble) => (args, env) => {
    const assembled = assemble(args, env)
    if (!assembled.ok) return assemblyFailure(assembled)
    return callPlan(deps.session, 'session', method, assembled.args)
  }

  /** 工作区写类命令：装配后反向调 `workspace` 对应方法。 */
  const workspaceCommand = (method) => (args, env) => {
    const assembled = assembleWorkspaceWriteArgs(args, env)
    if (!assembled.ok) return assemblyFailure(assembled)
    return callPlan(deps.workspace, 'workspace', method, assembled.args)
  }

  return {
    ping: () => ({ pong: true, identity: deps.identity }),

    newConversation: sessionCommand('new_conversation', assembleSessionArgs),
    selectConversation: sessionCommand('select', assembleSessionArgs),
    renameConversation: sessionCommand('rename', assembleSessionArgs),
    deleteConversation: sessionCommand('delete', assembleSessionArgs),
    restoreConversation: sessionCommand('restore', assembleSessionArgs),
    branchConversation: sessionCommand('branch', assembleBranchArgs),

    listWorkspaces: (args) => callValue(deps.workspace, 'workspace', 'list', assembleWorkspaceListArgs(args)),

    pickWorkspace: () => callValue(deps.workspace, 'workspace', 'pick', {}),

    addWorkspace: workspaceCommand('add'),
    removeWorkspace: workspaceCommand('remove'),

    revealWorkspace: (args) => callValue(deps.workspace, 'workspace', 'reveal', assembleRevealArgs(args)),
  }
}
