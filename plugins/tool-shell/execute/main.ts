// `tool-shell` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道；执行与密钥解析全部经反向调用。

import { spawnSync } from 'node:child_process'

import { defineService } from 'plugin-sdk'
import { createLink, RemoteExec, RemoteSecrets } from './backends.ts'
import { createHandlers } from './methods.ts'
import type { ShellProfile } from './describe.ts'
import type { Rec } from './types.ts'

/** 解释器存在性冒烟：跑一条立即退出的命令，只看退出码（不校验版本，更新版本无需改代码）。 */
function probeCommand(cmd: string, args: string[]): boolean {
  const probe = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true })
  return probe.status === 0
}

/** python 解释器：unix 优先 `python3`，缺失回落 `python`（Windows 两者同名）。 */
function resolvePython(): string {
  return probeCommand('python3', ['-c', 'pass']) ? 'python3' : 'python'
}

/** Windows：`pwsh`（Core，二进制名跨版本恒定）→ `pwsh-preview` → `powershell.exe`（系统自带 5.1）。 */
function resolveWindowsProfile(): ShellProfile {
  const cmd =
    ['pwsh', 'pwsh-preview', 'powershell.exe'].find((candidate) =>
      probeCommand(candidate, ['-NoProfile', '-Command', 'exit 0']),
    ) ?? 'powershell.exe'
  return {
    command: {
      cmd,
      argsPrefix: ['-NoProfile', '-Command'],
      // 5.1 缺省按本机 ANSI / OEM 代码页写 stdout（中文会乱码）；开命令前把控制台与管道编码统一到 UTF-8。
      preamble:
        'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; $OutputEncoding = [System.Text.Encoding]::UTF8',
    },
    session: { cmd, argsPrefix: ['-NoProfile', '-NoLogo', '-NoExit', '-Command', '-'] },
    sessionSyntax: 'powershell',
    python: resolvePython(),
    label: cmd,
    syntax: 'PowerShell',
  }
}

/** unix：`bash` → `sh`；命令按 POSIX shell 语法执行。 */
function resolvePosixProfile(): ShellProfile {
  const cmd = ['bash', 'sh'].find((candidate) => probeCommand(candidate, ['-c', 'exit 0'])) ?? 'sh'
  return {
    command: { cmd, argsPrefix: ['-c'] },
    session: { cmd, argsPrefix: ['-s'] },
    sessionSyntax: 'posix',
    python: resolvePython(),
    label: cmd,
    syntax: 'POSIX shell',
  }
}

/** 平台原生 shell 口令：服务启动时一次性探测，结果注入 describe 与 invoke。 */
function resolveShellProfile(): ShellProfile {
  return process.platform === 'win32' ? resolveWindowsProfile() : resolvePosixProfile()
}

/** 构造服务实例：反向调用通道 + 执行 / 密钥后端由本插件提供。 */
export const createService = defineService({
  entry: import.meta.url,
  capability: 'tool-shell',
  logPrefix: 'tool-shell',
  setup: (ctx) => {
    const link = createLink(ctx.emit)
    let liveSeq = 0
    // 调用中途上行 `tool.delta`（前台命令实时输出）；帧 id 与 SDK 的事件序号空间错开，避免撞车。
    const emitLive = (topic: string, payload: Rec): void => {
      liveSeq += 1
      ctx.emit({ v: '1', id: `tool-shell-live-${liveSeq}`, kind: 'event', topic, payload })
    }
    return {
      handlers: createHandlers({
        exec: new RemoteExec(link),
        secrets: new RemoteSecrets(link),
        profile: resolveShellProfile(),
        emit: emitLive,
      }),
      portLinks: [link],
    }
  },
})
