// 能力类 `ui-approval` 的方法表：ping 占位 + 三条命令的服务侧装配。
// 服务不读投影、不发 eff：入口 term 的投影切片（list 用于影子指标）随 args 传入；
// 裁决经宿主反向调用（`port.call`）调 `approval`（队列自有存储）与 `input`（作答槽），并在服务内拼续跑计划。
// 只返回值 / 计划（`$directives`），不落账、不自取时钟。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import {
  allRefsOf,
  asString,
  directivesOf,
  externOnly,
  failure,
  itemsOf,
  MAIN_THREAD,
  normalizeVerdict,
  resumeDirectives,
  shadowRefsOf,
  withExternPayload,
} from './plan.ts'
import type { Rec } from './plan.ts'
import type { PortCaller } from './port-link.ts'
import { BadArgsError, isRecord } from './types.ts'
import type { CallEnv, Handler, Json } from './types.ts'

export interface HandlerDeps {
  identity: string
  approval: PortCaller
  input: PortCaller
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

/** 从 `approval` 回执的 extern 载荷取续跑目标：`decide_all` 用 `resumes`，`decide` 用单项。 */
function resumesOf(payload: Rec | null): Rec[] {
  if (payload === null || payload['ok'] !== true) return []
  const list = payload['resumes']
  if (Array.isArray(list)) return list.filter(isRecord)
  const resume = payload['resume']
  if (resume === undefined) return []
  return [{ thread: payload['thread'] ?? null, resume }]
}

/** 裁决主流程（单条 / 整批共用）：读 input 槽 → 反向调 approval → 拼续跑计划 → 清槽。 */
async function decideCore(deps: HandlerDeps, env: CallEnv, mode: DecideMode): Promise<Json> {
  const threadKey = asString(env.thread) ?? MAIN_THREAD
  const read = await deps.input.call('input', 'read', { thread: threadKey })
  if (!read.ok) return externOnly(failure(read.code, read.message))
  const slot = isRecord(read.value) ? read.value['slot'] : null
  const verdict = isRecord(slot) && slot['kind'] === 'approval.decide' ? normalizeVerdict(slot['verdict']) : null
  if (verdict === null) {
    await deps.input.call('input', 'clear', { thread_id: threadKey })
    return externOnly(failure('bad_slot', 'bad_slot'))
  }

  const args: Rec = { thread_id: threadKey, verdict }
  if (mode === 'single') {
    const id = asString(slot['id'])
    if (id !== null) args['id'] = id
  }
  const outcome = await deps.approval.call('approval', mode === 'all' ? 'decide_all' : 'decide', args)
  // 无论成败都清槽：失败残留非法槽会挡住后续裁决。
  await deps.input.call('input', 'clear', { thread_id: threadKey })
  if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
  const approvalPlan = directivesOf(outcome.value)
  if (approvalPlan === null) return externOnly(failure('bad_plan', 'bad_plan'))
  return { $directives: [...approvalPlan, ...resumeDirectives(resumesOf(parseExternPayload(outcome.value)), verdict)] }
}

function parseExternPayload(value: Json): Rec | null {
  const directives = directivesOf(value)
  if (directives === null) return null
  for (let index = directives.length - 1; index >= 0; index--) {
    const item = directives[index]
    if (isRecord(item) && item['kind'] === 'extern' && isRecord(item['payload'])) return item['payload'] as Rec
  }
  return null
}

/** 构造方法表；`deps.approval` / `deps.input` 是反向调用通道（单测注入假端口）。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  return {
    ping: (): Json => ({ pong: true, identity: deps.identity }),

    /**
     * 待审批队列（含 pending / expired）：反向调 `approval.list`，结果即命令结果。
     * 只读：不构造任何 write；另附各 item `shadow` def body（跨身份 refs 可达者），供 UI 解析影子指标。
     */
    list: async (args): Promise<Json> => {
      const outcome = await deps.approval.call('approval', 'list', {})
      if (!outcome.ok) return externOnly(failure(outcome.code, outcome.message))
      const shadows = shadowRefsOf(itemsOf(outcome.value), allRefsOf(args))
      return withExternPayload(outcome.value, { refs: shadows })
    },

    /** 单条裁决：读本线程 `approval.decide` 槽 → 反向调 `approval` → 拼 `chat.resume` 续跑计划。 */
    decide: (args, env): Promise<Json> => decideCore(deps, env, 'single'),

    /** 整批裁决：对全部 `pending` 项给同一 verdict。 */
    decide_all: (args, env): Promise<Json> => decideCore(deps, env, 'all'),

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
