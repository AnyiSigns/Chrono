// 能力类 `ui-sidebar` 的方法表：只做**投影装配 + 反向调用**，不读投影、不落账、不自取时钟。
// 入口 term 把 `ctx.ids` 投影切片随 args 传入；本服务从中取输入槽（per-thread 键控，缺省 `_main`）
// 与会话 / 工作区 body，经宿主反向调用（`port.call`，见协议文档 §2.4）转给 `session` / `workspace`。
// 依赖服务返回写计划（`$directives`）时原样上提给宿主落账；读命令返回结构化值。

import { CLIENT_WEB_DIR, readClientFile } from './client-files.js'
import { createRefHydrator, hydrateIds } from './refs.js'
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

/** 投影里某身份的 data_gen（写方据此把下一世代写成补丁世代）；缺失回 null。 */
export function identityDataGen(ids, id) {
  if (!isRecord(ids)) return null
  const entry = ids[id]
  if (!isRecord(entry) || entry['data_gen'] === undefined) return null
  return entry['data_gen']
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
  // 身份切片并入 `data_gen`（有则写补丁世代；session 服务按 `sessionDataOf` 归一、忽略元数据）。
  const sessionSlice = { ...session }
  const sessionGen = identityDataGen(ids, 'session')
  if (sessionGen !== null) sessionSlice['data_gen'] = sessionGen
  const slotsSlice = { ...slots }
  const slotsGen = identityDataGen(ids, 'input')
  if (slotsGen !== null) slotsSlice['data_gen'] = slotsGen
  return {
    ok: true,
    args: { session: sessionSlice, slots: slotsSlice, thread_id: threadId, slot: slotOf(slots, threadId) },
  }
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
 *
 * 投影对**无数据世代**的身份回落代码 commit body（`{meta,tree}`，见宿主投影口径）；工作区尚未有数据世代时
 * 该回落体不含 `workspaces`，直接透传会被依赖服务按「缺 workspaces body」拒收。此处归一为**规范空体**
 * （`{version:1, workspaces:[]}`）——与「无既有工作区」的事实一致，非破坏性。
 */
export function assembleWorkspaceWriteArgs(ids, env) {
  const raw = identityBody(ids, 'workspace')
  if (raw === null) return { ok: false, code: 'workspace_missing' }
  const body = Array.isArray(raw['workspaces']) ? raw : { version: 1, workspaces: [] }
  const slots = identityBody(ids, 'input')
  if (slots === null) return { ok: false, code: 'input_missing' }
  const threadId = threadKeyOf(env)
  const args = { body, slots, thread_id: threadId, slot: slotOf(slots, threadId) }
  const bodyGen = identityDataGen(ids, 'workspace')
  if (bodyGen !== null) args['body_data_gen'] = bodyGen
  const slotsGen = identityDataGen(ids, 'input')
  if (slotsGen !== null) args['slots_data_gen'] = slotsGen
  return { ok: true, args }
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
  const read = async (identity, hashes) => {
    if (deps.host === undefined) return null
    const outcome = await deps.host.call('host', 'def.read', { identity, hashes })
    if (!outcome.ok) return null
    return isRecord(outcome.value) ? outcome.value : null
  }
  const hydrator = createRefHydrator(read)

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

    /** 只读交付面：读本插件客户端半边字节（路径穿越防护见 `client-files.js`）。 */
    clientRead: (args) => {
      const path = isRecord(args) ? asString(args['path']) : null
      if (path === null) throw new BadArgsError('path required')
      const result = readClientFile(CLIENT_WEB_DIR, path)
      if (!result.ok) throw new BadArgsError(result.code)
      return { path: result.path, text: result.text }
    },

    newConversation: sessionCommand('new_conversation', assembleSessionArgs),
    selectConversation: sessionCommand('select', assembleSessionArgs),
    renameConversation: sessionCommand('rename', assembleSessionArgs),
    deleteConversation: sessionCommand('delete', assembleSessionArgs),
    restoreConversation: sessionCommand('restore', assembleSessionArgs),
    /** 分支：源链引用按需解析（投影只回引用）后再装配。 */
    branchConversation: async (args, env) => {
      const ids = await hydrateIds(args, ['session'], hydrator)
      const assembled = assembleBranchArgs(ids, env)
      if (!assembled.ok) return assemblyFailure(assembled)
      return callPlan(deps.session, 'session', 'branch', assembled.args)
    },

    listWorkspaces: (args) => callValue(deps.workspace, 'workspace', 'list', assembleWorkspaceListArgs(args)),

    pickWorkspace: () => callValue(deps.workspace, 'workspace', 'pick', {}),

    addWorkspace: workspaceCommand('add'),
    removeWorkspace: workspaceCommand('remove'),

    revealWorkspace: (args) => callValue(deps.workspace, 'workspace', 'reveal', assembleRevealArgs(args)),
  }
}
