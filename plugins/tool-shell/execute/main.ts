// `tool-shell` 服务入口：三形态共用（stdio 起帧循环；inproc / worker 由宿主 import 后直调）。
// manifest 由 SDK 从同包 plugin.json 派生；stdout 只发协议帧，日志走 stderr；stdin EOF 即自退出。
// 服务不读投影、无写通道；执行与密钥解析全部经反向调用。

import { spawnSync } from 'node:child_process'

import {
  createService as createSdkService,
  isDirectRun,
  makeLogger,
  packageRootOf,
  runStdio,
} from 'plugin-sdk'
import type { ServiceFactoryContext, ServiceInstance } from 'plugin-sdk'
import { createLink, RemoteExec, RemoteSecrets } from './backends.ts'
import { createHandlers } from './methods.ts'

const CAPABILITY = 'tool-shell'
const LOG = makeLogger('tool-shell')

/**
 * 解析命令形态的 PowerShell 解释器，按优先级探测：`pwsh`（PowerShell Core，二进制名跨版本恒定，
 * 比 7 新的稳定版同名）→ `pwsh-preview`（预览版）→ `powershell.exe`（仅 Windows，系统自带 5.1）。
 * 探测是存在性冒烟（`exit 0`），不校验版本，故更新版本无需改代码；服务启动时一次性执行，结果注入 invoke。
 */
function resolveShellCommand(): string {
  const candidates =
    process.platform === 'win32'
      ? ['pwsh', 'pwsh-preview', 'powershell.exe']
      : ['pwsh', 'pwsh-preview']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-NoProfile', '-Command', 'exit 0'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (probe.status === 0) return candidate
  }
  return candidates[0]
}

/** 构造服务实例：反向调用通道 + 执行 / 密钥后端由本插件提供。 */
function build(ctx: ServiceFactoryContext): ServiceInstance {
  const link = createLink(ctx.emit)
  return createSdkService({
    pluginRoot: packageRootOf(import.meta.url),
    capability: CAPABILITY,
    handlers: createHandlers({
      exec: new RemoteExec(link),
      secrets: new RemoteSecrets(link),
      shell: resolveShellCommand(),
    }),
    emit: ctx.emit,
    log: LOG,
    portLinks: [link],
  })
}

export const createService = build

if (isDirectRun(import.meta.url)) {
  runStdio(build, { log: LOG })
}
