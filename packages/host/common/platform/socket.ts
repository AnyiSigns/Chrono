// 入站面地址派生：Windows 为 named pipe（根路径摘要派生，避免同机多仓库撞名），
// POSIX 为 unix domain socket 文件。宿主与客户端各自实现，靠静态对表钉死不漂。

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { isWindows } from './os.ts'

/** 入站面地址：win32 命名管道，其余平台为 `<root>/state/sock/host.sock`。 */
export function socketAddress(root: string): string {
  if (isWindows()) {
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\chrono-host-${digest}`
  }
  return resolve(root, 'state', 'sock', 'host.sock')
}
