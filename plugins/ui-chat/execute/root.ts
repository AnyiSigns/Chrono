// 宿主根目录与入站 socket 地址推导。
// 宿主以 `CHRONO_PLUGIN_STATE=<root>/state/plugins/<id>` 注入本进程（docs/host.md §五 插件 ③ 目录），
// 故上溯三级即 root；socket 地址派生规则与 packages/host/paths.ts 一致（两侧各自实现、不跨包 import）。

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

/** 由 `CHRONO_PLUGIN_STATE` 推导宿主根；缺失时回落 `CHRONO_ROOT`，再回落给定工作目录。 */
export function rootFromPluginState(env: { [key: string]: string | undefined }, cwd: string): string {
  const state = env['CHRONO_PLUGIN_STATE']
  if (typeof state === 'string' && state.length > 0) return resolve(state, '..', '..', '..')
  const explicit = env['CHRONO_ROOT']
  if (typeof explicit === 'string' && explicit.length > 0) return resolve(explicit)
  return resolve(cwd)
}

/** 入站面地址：POSIX 为 unix domain socket 文件，Windows 为 named pipe（按 root 摘要防撞名）。 */
export function inboundSocketPath(root: string): string {
  if (process.platform === 'win32') {
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\chrono-host-${digest}`
  }
  return resolve(root, 'state', 'sock', 'host.sock')
}
