// 能力类 `ui-sidebar` 的方法表：只做**投影装配 + 反向调用**，不读投影、不落账、不自取时钟。
// 入口 term 把 `ctx.ids` 投影切片随 args 传入；会话 body 来自投影，**输入槽来自 `input` owner 服务**
// （槽已出世界，经 `input.read` 反向调用取），工作区 body 来自投影，经宿主反向调用（`port.call`）转给
// `session` / `workspace`。依赖服务返回结果值（不再产世界写计划）；读命令返回结构化值。

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

/** 输入 body 里本线程的槽体；缺失返回 null。 */
export function slotOf(inputBody, threadId) {
  if (!isRecord(inputBody) || !isRecord(inputBody['slots'])) return null
  return inputBody['slots'][threadId] ?? null
}

/** 输入槽读口：向 `input` owner 反向调用 `input.read`（槽已出世界，不再走投影切片）。 */
export async function readInput(deps, threadId) {
  if (deps.input === undefined) return { body: null, slot: null }
  const outcome = await deps.input.call('input', 'read', {})
  if (!outcome.ok || !isRecord(outcome.value)) return { body: null, slot: null }
  const body = outcome.value
  const slots = isRecord(body['slots']) ? body['slots'] : null
  return { body, slot: slots !== null ? (slots[threadId] ?? null) : null }
}

/**
 * 会话类命令（new / select / rename / delete / restore）的公共装配：
 * `{session, slots, thread_id, slot}`——会话服务据此判槽 kind、切 current、清本线程槽。
 * `session` 来自投影切片，`slots` / `slot` 来自 `input` owner 服务（输入槽已出世界）。
 */
export function assembleSessionArgs(ids, env, input) {
  const session = identityBody(ids, 'session')
  if (session === null) return { ok: false, code: 'session_missing' }
  if (input === null || input.body === null) return { ok: false, code: 'input_missing' }
  const threadId = threadKeyOf(env)
  return {
    ok: true,
    args: { session: { ...session }, slots: input.body, thread_id: threadId, slot: input.slot },
  }
}

/** 分支装配：在会话类公共装配上补源链 `refs`（`session.branch` 需要沿 prev 还原链）。 */
export function assembleBranchArgs(ids, env, input) {
  const base = assembleSessionArgs(ids, env, input)
  if (!base.ok) return base
  return { ok: true, args: { ...base.args, refs: identityRefs(ids, 'session') } }
}

/** `workspace.list` 装配：服务读自有存储后逐项 stat；本服务不传列表。 */
export function assembleWorkspaceListArgs() {
  return {}
}

/** `workspace.reveal` 装配：只取 id（服务按 id 在自有存储的清单里解析 path，不信任裸路径）。 */
export function assembleRevealArgs(args) {
  if (!isRecord(args)) throw new BadArgsError('workspace required')
  const workspace = asString(args['workspace'])
  if (workspace === null) throw new BadArgsError('workspace required')
  return { workspace }
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

  /** 会话类命令：从 `input` owner 读本线程槽后装配，再反向调 `session` 对应方法。 */
  const sessionCommand = (method, assemble) => async (args, env) => {
    const input = await readInput(deps, threadKeyOf(env))
    const assembled = assemble(args, env, input)
    if (!assembled.ok) return assemblyFailure(assembled)
    return callPlan(deps.session, 'session', method, assembled.args)
  }

  /**
   * 工作区写类命令：从 `input` 服务读本线程槽（清单已出世界，槽体不在投影），
   * 反向调 `workspace` 写自有存储，随后经 `input.clear` 清本线程槽（无论成败，否则残留槽会让下一回合判非法槽 kind）。
   * `workspace` 返回结果值（不再产世界写计划）。
   */
  const workspaceCommand = (method) => async (args, env) => {
    const threadId = threadKeyOf(env)
    const read = await deps.input.call('input', 'read', { thread: threadId })
    const inputBody = read.ok && isRecord(read.value) ? read.value : { slots: {} }
    const slot = slotOf(inputBody, threadId)
    if (slot === null) return externOnly(failure('slot_missing', 'slot_missing'))
    const outcome = await deps.workspace.call('workspace', method, { slot, thread_id: threadId })
    await deps.input.call('input', 'clear', { thread_id: threadId })
    if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
    return externOnly(outcome.value)
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
    /** 分支：源链引用按需解析（投影只回引用）后装配。 */
    branchConversation: async (args, env) => {
      const ids = await hydrateIds(args, ['session'], hydrator)
      const input = await readInput(deps, threadKeyOf(env))
      const assembled = assembleBranchArgs(ids, env, input)
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
