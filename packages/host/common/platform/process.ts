// 进程平台差异：进程组终止形态（Windows `taskkill /T /F` / POSIX 进程组）、
// 独立进程组开关与进程存活探针。其余模块只调本层，不再自写 `process.platform` 分支。

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { isWindows } from './os.ts'

/** 宿主 spawn 服务时是否建独立进程组（POSIX 才支持负 pid 杀整组；Windows 无该语义）。 */
export function detachedProcessGroup(): boolean {
  return !isWindows()
}

/**
 * 杀服务进程树：宿主以 shell 起服务，`child.kill()` 只杀 shell 包装进程，
 * 会遗留真正的服务进程。Windows 用 `taskkill /T /F`，POSIX 用进程组（spawn 时 detached）。
 * 不让 `child.kill()` 与 `taskkill` 抢跑——抢跑会缩短 taskkill 枚举子树的窗口。
 *
 * 已知限制（Windows）：`taskkill` 是异步的，极窄窗口内 shell 已 fork 但尚未被枚举到的
 * 孙进程可能漏网；漏网进程由「stdin EOF 自退出」义务兜底（宿主关闭通道即 EOF）。
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined) return
  if (isWindows()) {
    let killer: ChildProcess | null = null
    try {
      killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch {
      // spawn 同步抛出（参数非法等）：退回直接 kill
      killer = null
    }
    if (killer !== null) {
      // spawn 失败是异步 'error' 事件，紧随的 catch 覆盖不到；挂监听免成未捕获异常，
      // 并在 taskkill 起不来时退回直接 kill（杀 shell 包装进程，孙进程由 EOF 义务兜底）。
      killer.on('error', () => {
        try {
          child.kill()
        } catch {
          // 进程可能已退出
        }
      })
      killer.unref()
      return
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
      return
    } catch {
      // 进程组不可用时退回直接 kill
    }
  }
  try {
    child.kill()
  } catch {
    // 进程可能已退出
  }
}

/** 进程存活：`kill(pid, 0)` 探针；EPERM 表示存在但无权限，视为存活。 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}
