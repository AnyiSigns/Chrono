// 能力类 `ui-approval` 的方法表：ping 占位 + 三条命令的服务侧装配。
// 服务不读投影、不发 eff：入口 term 把 `ctx.ids` 切片随 args 传入，服务从中取 `#1` 槽与 `#32` 队列，
// 经宿主反向调用（`port.call`，docs/protocol.md §2.4）调 `approval` 端口，并在服务内拼续跑计划。
// 只返回值 / 计划（`$directives`），不落账、不自取时钟。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import {
  asString,
  clearReject,
  directivesOf,
  externOnly,
  failure,
  inputBodyOf,
  itemById,
  itemsFromChain,
  MAIN_THREAD,
  normalizeVerdict,
  pendingItems,
  queueOf,
  refsOf,
  resumeDirectives,
  shadowRefsOf,
  slotOf,
  withExternPayload,
} from './plan.ts'
import { createRefHydrator } from './refs.ts'
import type { DefReader } from './refs.ts'
import type { PortCaller } from './port-link.ts'
import { BadArgsError, isRecord } from './types.ts'
import type { CallEnv, Handler, Json, Rec } from './types.ts'

export interface HandlerDeps {
  identity: string
  approval: PortCaller
  /** 宿主只读解析通道（`host.def.read`）；缺省时只接受已解析的 refs 对象（单测便利）。 */
  host?: PortCaller
  /** 客户端半边根目录（`execute/web/`）：`client.read` 只在此目录内按包内相对 `.js` 路径读。 */
  webRoot: string
}

/**
 * 客户端半边入口路径防护：只接受包内相对 `.js` 路径。
 * 拒绝绝对路径 / 盘符 / 反斜杠 / `..` / `.` / 空段 / 空串 / 非 `.js`。
 */
export function isSafeClientPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\\') || value.includes('\u0000')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) return false
  return value.endsWith('.js')
}

/** 读客户端半边文件：路径防护 + 结果必须落在 `webRoot` 内；越界 / 不存在回 null。 */
export function readClientFile(webRoot: string, path: string): { path: string; text: string } | null {
  if (!isSafeClientPath(path)) return null
  const root = resolve(webRoot)
  const full = resolve(root, path)
  if (full !== root && !full.startsWith(root + sep)) return null
  try {
    return { path, text: readFileSync(full, 'utf8') }
  } catch {
    return null
  }
}

/** 裁决模式：单条（读槽 `id`）或整批（全部 `pending`）。 */
export type DecideMode = 'single' | 'all'

/** `approval.list` 入参：`#32` 队列 body + item 引用闭包（服务不读投影）。`refs` 缺省取投影切片。 */
export function assembleListArgs(ids: Json, refs?: Rec): Rec {
  return { queue: queueOf(ids), refs: refs ?? refsOf(ids) }
}

/**
 * `approval.decide` / `decide_all` 的裁决入参：队列 + 引用 + 本线程槽 + 线程键。
 * `slots` 传整份输入 body（#32 侧 per-thread 读槽 / 清槽用），`thread_id` 定线程键。
 */
export function assembleDecideArgs(ids: Json, threadKey: string, refs?: Rec): Rec {
  const inputBody = inputBodyOf(ids)
  const args: Rec = { queue: queueOf(ids), refs: refs ?? refsOf(ids), thread_id: threadKey }
  if (inputBody !== null) args['slots'] = inputBody
  return args
}

/** 本线程 `approval.decide` 槽体；非该 kind 回 null（坏槽 kind 结构化拒）。 */
export function decideSlotOf(ids: Json, threadKey: string): Rec | null {
  const slot = slotOf(inputBodyOf(ids), threadKey)
  return slot !== null && slot['kind'] === 'approval.decide' ? slot : null
}

/**
 * 顶层裁决计划：`[eval(command:'chat.resume'), …#32 计划]`。
 * 续跑条目按被裁决项逐条产（每项各自游标 / 线程；投影由宿主执行期注入，不内嵌）；
 * `#32` 计划原样接在其后（写裁决 + 清槽 + extern）。
 */
export function buildDecisionPlan(targets: Rec[], verdict: string, approvalPlan: Json[]): Json {
  return { $directives: [...resumeDirectives(targets, verdict), ...approvalPlan] }
}

/** 单条裁决的目标项：槽里的 `id` 命中的 item；无 `id` / 找不到回空。 */
function singleTarget(items: Rec[], slot: Rec): Rec[] {
  const id = asString(slot['id'])
  if (id === null) return []
  const target = itemById(items, id)
  return target === null ? [] : [target]
}

/** 裁决主流程（单条 / 整批共用）：校验槽 → 解析引用 → 反向调 #32 → 拼续跑计划。 */
async function decideCore(
  deps: HandlerDeps,
  args: Json,
  env: CallEnv,
  mode: DecideMode,
  hydrate: (refs: Json) => Promise<Rec>,
): Promise<Json> {
  const ids = args
  const threadKey = asString(env.thread) ?? MAIN_THREAD
  const inputBody = inputBodyOf(ids)
  const slot = decideSlotOf(ids, threadKey)
  const verdict = slot === null ? null : normalizeVerdict(slot['verdict'])
  if (verdict === null) return clearReject(inputBody, threadKey, 'bad_slot')

  const queue = queueOf(ids)
  const refs = await hydrate(refsOf(ids))
  const items = itemsFromChain(queue, refs)
  const targets = mode === 'all' ? pendingItems(items) : singleTarget(items, slot as Rec)
  const method = mode === 'all' ? 'decide_all' : 'decide'
  const outcome = await deps.approval.call('approval', method, assembleDecideArgs(ids, threadKey, refs))
  if (!outcome.ok) return clearReject(inputBody, threadKey, outcome.code)
  const approvalPlan = directivesOf(outcome.value)
  if (approvalPlan === null) return clearReject(inputBody, threadKey, 'bad_plan')
  return buildDecisionPlan(targets, verdict, approvalPlan)
}

/** 构造方法表；`deps.approval` 是反向调用通道（单测注入假端口），`deps.host` 是只读解析通道。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  const read: DefReader = async (identity, hashes) => {
    if (deps.host === undefined) return null
    const outcome = await deps.host.call('host', 'def.read', { identity, hashes })
    if (!outcome.ok) return null
    return isRecord(outcome.value) ? outcome.value : null
  }
  const hydrator = createRefHydrator(read)
  const hydrate = (refs: Json): Promise<Rec> => hydrator.hydrate('approval', refs)
  return {
    ping: (): Json => ({ pong: true, identity: deps.identity }),

    /**
     * 待审批队列（含 pending / expired）：服务装配 `#32` 队列切片后反向调 `approval.list`，结果即命令结果。
     * 只读：不构造任何 write；另附各 item `shadow` def body（有则附），供 UI 解析影子指标。
     */
    list: async (args): Promise<Json> => {
      const refs = await hydrate(refsOf(args))
      const outcome = await deps.approval.call('approval', 'list', assembleListArgs(args, refs))
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      const shadows = shadowRefsOf(itemsFromChain(queueOf(args), refs), refs)
      return withExternPayload(outcome.value, { refs: shadows })
    },

    /** 单条裁决：读本线程 `approval.decide` 槽 → 反向调 #32 → 拼 `chat.resume` 续跑计划。 */
    decide: (args, env): Promise<Json> => decideCore(deps, args, env, 'single', hydrate),

    /** 整批裁决：对全部 `pending` 项给同一 verdict。 */
    decide_all: (args, env): Promise<Json> => decideCore(deps, args, env, 'all', hydrate),

    /**
     * 客户端半边交付：只读命令 `ui-approval.client.read` 的方法侧。
     * 产物在物化目录内、被 `.worldignore` 排除，`host.source.read` 读不到，故由本服务按包内相对
     * `.js` 路径读自己的文件回字节。路径穿越（绝对 / 盘符 / 反斜杠 / `..` / 空段）结构化拒。
     */
    'client.read': (args): Json => {
      const path = isRecord(args) ? args['path'] : undefined
      if (!isSafeClientPath(path)) throw new BadArgsError('unsafe client path')
      const file = readClientFile(deps.webRoot, path)
      if (file === null) throw new BadArgsError('client file unavailable')
      return { path: file.path, text: file.text }
    },
  }
}
