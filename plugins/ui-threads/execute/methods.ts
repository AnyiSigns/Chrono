// 能力类 `ui-threads` 的方法表：`ping` 健康占位 + `threads.state` 标签数据装配 + `client.read` 客户端半边交付。
// `threads.state` 经反向调用问 owner：`session.list` 取会话清单（body + open_turns）、`todo.invoke(todo.read)`
// 取待办清单（session / todo 运行记录已出世界，故服务不读世界投影）。`client.read` 按包内相对 `.js` 路径回字节。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { PortCaller } from 'plugin-sdk'
import { resolveRootMainId } from './web/threads-model.ts'
import { assembleThreadsState } from './threads-state.ts'
import { isRecord } from './types.ts'
import type { Handler, Json } from './types.ts'

export interface HandlerDeps {
  identity: string
  /** 浏览器客户端半边资产根目录（`execute/web/`）；`client.read` 只在此目录内解析。 */
  webRoot: string
  /** 反向调用通道（`session.list` / `todo.invoke`，按 pins 路由）；单测注入假端口。 */
  port: PortCaller
}

export interface ClientFile {
  path: string
  text: string
}

/**
 * 只接受包内相对 `.js` 路径：拒绝空值 / 绝对路径 / 盘符 / 反斜杠 / 空段 / `.` / `..`。
 * 路径穿越防护的第一道（语法层）。
 */
export function isSafeClientPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.includes('\\') || value.includes('\u0000')) return false
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    return false
  }
  return value.endsWith('.js')
}

/**
 * 读回包内 `.js` 资产字节：路径不安全 / 解析后越出根目录 / 读失败 → null。
 * 第二道为解析后前缀校验（防符号链接 / 归一化绕过）。
 */
export function readClientFile(webRoot: string, path: unknown): ClientFile | null {
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

/** 运行记录 owner 身份：会话清单 `session.list`、待办清单 `todo.invoke`（均已出世界）。 */
const SESSION_PORT = 'session'
const SESSION_LIST = 'list'
const TODO_PORT = 'todo'
const TODO_INVOKE = 'invoke'

/** 取 owner `session.list` 清单（body + open_turns）；取不到回空清单（顶栏显示无会话，不崩）。 */
async function readSession(port: PortCaller): Promise<Json> {
  const outcome = await port.call(SESSION_PORT, SESSION_LIST, {})
  return outcome.ok && isRecord(outcome.value) ? outcome.value : {}
}

/** 取 owner 待办清单（`todo.read`，按根会话 id）；无根 / 取不到回 null。 */
async function readTodo(port: PortCaller, rootId: string | null): Promise<Json> {
  if (rootId === null) return null
  const outcome = await port.call(TODO_PORT, TODO_INVOKE, { tool: 'todo.read', session_id: rootId })
  if (!outcome.ok || !isRecord(outcome.value) || outcome.value['ok'] !== true) return null
  return isRecord(outcome.value['result']) ? (outcome.value['result'] as Json) : null
}

/** 构造方法表；main.ts 注入反向调用通道，单测可注入假端口。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  return {
    ping: (): { value: Json; events: [] } => ({ value: { pong: true, identity: deps.identity }, events: [] }),

    /** 问 owner 取会话切片 + 待办清单，装配线程标签 + 待办视图（父会话隔离）。 */
    'threads.state': async (): Promise<{ value: Json; events: [] }> => {
      const session = await readSession(deps.port)
      const root = resolveRootMainId(session['conversations'], session['current'])
      const todo = await readTodo(deps.port, root)
      return { value: assembleThreadsState(session, todo), events: [] }
    },

    /** 壳经 `<id>.client.read` 取客户端半边字节：`{path}` → `{path,text}`；非法路径 fail-closed。 */
    'client.read': (args): { value: Json; events: [] } => {
      const path = isRecord(args) ? args['path'] : null
      const file = readClientFile(deps.webRoot, path)
      if (file === null) throw new Error(`client.read refused: ${String(path)}`)
      return { value: { path: file.path, text: file.text }, events: [] }
    },
  }
}
