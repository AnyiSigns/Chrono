// 能力类 `ui-threads` 的方法表：`ping` 健康占位 + `threads.state` 标签数据装配 + `client.read` 客户端半边交付。
// 服务不读投影、无写通道：`threads.state` 只从入口 term 随 args 传入的 `ctx.ids` 切片里取数。
// `client.read` 是只读命令：按包内相对 `.js` 路径回字节，做路径穿越防护。

import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { assembleThreadsState } from './threads-state.ts'
import { isRecord } from './types.ts'
import type { Handler, Json } from './types.ts'

export interface HandlerDeps {
  identity: string
  /** 浏览器客户端半边资产根目录（`execute/web/`）；`client.read` 只在此目录内解析。 */
  webRoot: string
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

/** 构造方法表；main.ts 校验 `port` / `method` 后取用。 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  return {
    ping: (): { value: Json } => ({ value: { pong: true, identity: deps.identity } }),

    /** 入口 term 传 `ctx.ids`，服务装配线程标签 + 待办标签（父会话隔离）。 */
    'threads.state': (args): { value: Json } => ({ value: assembleThreadsState(args) }),

    /** 壳经 `<id>.client.read` 取客户端半边字节：`{path}` → `{path,text}`；非法路径 fail-closed。 */
    'client.read': (args): { value: Json } => {
      const path = isRecord(args) ? args['path'] : null
      const file = readClientFile(deps.webRoot, path)
      if (file === null) throw new Error(`client.read refused: ${String(path)}`)
      return { value: { path: file.path, text: file.text } }
    },
  }
}
