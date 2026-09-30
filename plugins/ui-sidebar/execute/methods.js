// 能力类 `ui-sidebar` 的方法表：只做**反向调用编排**，不读投影、不落账、不自取时钟。
// 会话 / 工作区写命令经 `input` owner 服务反向调用 `input.read` 取本线程槽（槽已出世界），
// 再经宿主反向调用（`port.call`）转给 `session` / `workspace`；不再预取世界投影。
// `workspace.pick` / `workspace.reveal` 由入口 term 直接 eff `workspace-picker`，不经本服务。
// 依赖服务返回结果值（不再产世界写计划）；读命令返回结构化值。

import { CLIENT_WEB_DIR, readClientFile } from './client-files.js'
import { BadArgsError, asString, isRecord } from './types.js'
import { externOnly, failure } from './plan.js'

/** 缺省线程键（per-thread 键控：读写只碰本键）。 */
export const MAIN_THREAD = '_main'

/** 线程键：调用帧 `env.thread` 非空字符串，否则 `_main`。 */
export function threadKeyOf(env) {
  return asString(env === null || env === undefined ? undefined : env.thread) ?? MAIN_THREAD
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
 * 会话类命令（new / select / rename / delete / restore / branch）的公共装配：
 * `{slots, thread_id, slot}`——会话服务据此判槽 kind、切 current、清本线程槽。
 * `slots` / `slot` 来自 `input` owner 服务（输入槽已出世界），不再预取世界投影。
 */
export function assembleSessionArgs(env, input) {
  if (input === null || input.body === null) return { ok: false, code: 'input_missing' }
  const threadId = threadKeyOf(env)
  return { ok: true, args: { slots: input.body, thread_id: threadId, slot: input.slot } }
}

/** 分支装配：与其它会话命令同参（源链由 `session.branch` 从 `store.messagesOf` 还原）。 */
export function assembleBranchArgs(env, input) {
  return assembleSessionArgs(env, input)
}

/** `workspace.list` 装配：服务读自有存储后逐项 stat；本服务不传列表。 */
export function assembleWorkspaceListArgs() {
  return {}
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
  /** 会话类命令：从 `input` owner 读本线程槽后装配，再反向调 `session` 对应方法。 */
  const sessionCommand = (method, assemble) => async (_args, env) => {
    const input = await readInput(deps, threadKeyOf(env))
    const assembled = assemble(env, input)
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
    branchConversation: sessionCommand('branch', assembleBranchArgs),

    listWorkspaces: (args) => callValue(deps.workspace, 'workspace', 'list', assembleWorkspaceListArgs(args)),

    /**
     * 清单面：向 `session` owner 反向调用 `session.list`，回会话 body + 开着的回合摘要。
     * 侧栏列表 / 顶栏线程标签据此取数，不再拖 `session.read` 的全切片（消息 / 回合 / refs）。
     */
    listConversations: () => callValue(deps.session, 'session', 'list', {}),

    /**
     * 只读回合面：向 `session` owner 反向调用 `session.list`，只回跨会话仍开着的回合摘要
     * （`open_turns`）。侧栏首屏据此补运行角标——重载后、下一个 `chat.turn.*` 事件到达前，
     * 也能显示哪些会话有开着的回合（含非当前会话）；其余清单字段不需要。
     */
    listTurns: async () => {
      const outcome = await deps.session.call('session', 'list', {})
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      const value = isRecord(outcome.value) ? outcome.value : {}
      const open = Array.isArray(value['open_turns']) ? value['open_turns'] : []
      return externOnly({ open_turns: open })
    },

    addWorkspace: workspaceCommand('add'),
    removeWorkspace: workspaceCommand('remove'),
  }
}
