// 入站面地址解析（客户端侧）：与服务端同一派生规则。

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export function resolveRoot(explicit?: string): string {
  const fromEnv = process.env['CHRONO_ROOT']
  return resolve(explicit ?? (fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd()))
}

export function socketPath(root: string): string {
  if (process.platform === 'win32') {
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\chrono-host-${digest}`
  }
  return resolve(root, 'state', 'sock', 'host.sock')
}
