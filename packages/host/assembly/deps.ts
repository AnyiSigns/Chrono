// 依赖恢复：插件包入世只带源码 + 依赖清单，`node_modules` / `target/` / 原生扩展等
// 编译产物与依赖目录走宿主侧依赖缓存，物化时按清单重建。
// 构建声明权归插件：`plugin.json.build` 是**唯一来源**——声明了什么就只跑什么，宿主不解释语言，
// 也不再按包内文件（`package.json` / 锁文件 / `Cargo.toml` 等）探测生态；空数组 = 显式无需构建。

import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ServiceStartError } from './supervision.ts'
import { DEFAULT_ECOSYSTEM } from './ecosystem.ts'
import type { EcosystemProfile } from './ecosystem.ts'
import type { PluginBuildStep } from './decl.ts'

/** 一步依赖恢复：要执行的命令与参数；直接来自 `plugin.json.build` 声明。 */
export interface RestoreStep {
  cmd: string
  args: string[]
}

/** 注入的命令执行器：失败（非零退出 / 进程错误）必须以 reject 表达。 */
export type DependencyRunner = (
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<void>

/**
 * 恢复完成标记：写在物化目录内，标记「本目录的清单已全部恢复」，不属于源码树、不进世界。
 * 物化目录名 = 世代 commit 哈希，而 commit 哈希内容定址（源码一变 tree 变、commit 变、目录变），
 * 故「依赖没变、只改源码」的换代落在**新目录**、天然没有标记 → 重新恢复 / 重新构建；
 * 旧目录的标记只对旧内容有效。依赖恢复与源码构建共用一个目录级标记不会漏构建：
 * 目录身份本身即源码内容身份，换代即换目录，标记不可能跨内容复用。
 */
const RESTORE_MARKER = '.chrono-deps-ok'

/**
 * 规划某物化目录的恢复 / 构建步骤（纯函数，只读文件系统）。
 * 以恢复完成标记为准：有标记说明本目录恢复过，跳过全部步骤；
 * 无标记则按 `build` 声明逐步执行，空数组 = 无需构建。
 * 声明是唯一来源：宿主不再探测包内 `package.json` / 锁文件 / `Cargo.toml` 等语言痕迹。
 */
export function planDependencyRestore(
  cwd: string,
  build: readonly PluginBuildStep[],
): RestoreStep[] {
  if (existsSync(join(cwd, RESTORE_MARKER))) return []
  return build.map((step) => ({ cmd: step.cmd, args: [...step.args] }))
}

/**
 * 按计划执行恢复 / 构建；任一步失败即抛 `ServiceStartError('deps_failed')`。
 * `build` 来自 `plugin.json.build`（入世已保证存在）：声明了什么就只跑什么。
 * 缓存目录指向宿主侧 `depsDir`，使多次物化共享下载与编译产物。
 * `wrapper` 与服务 `start` 同路前置：依赖安装与构建都会执行插件声明的 lifecycle 脚本，
 * 必须与起服务走同一沙箱包装，否则恢复 / 构建阶段成了绕过沙箱的口子。
 * 全部步骤成功后写恢复完成标记；任一步失败不写，下次启动重试（半恢复无法自愈）。
 */
export async function restoreDependencies(
  cwd: string,
  depsDir: string,
  build: readonly PluginBuildStep[],
  run?: DependencyRunner,
  wrapper?: string,
  ecosystem: EcosystemProfile = DEFAULT_ECOSYSTEM,
): Promise<void> {
  const steps = planDependencyRestore(cwd, build)
  if (steps.length === 0) return
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [ecosystem.npmCacheEnvVar]: join(depsDir, ecosystem.npmCacheDirName),
    // npm 12 默认 allow-remote=none，会让含依赖插件的 npm ci 拒绝拉取远端包而 deps_failed
    [ecosystem.npmAllowRemoteEnvVar]: ecosystem.npmAllowRemoteValue,
    [ecosystem.cargoTargetEnvVar]: join(depsDir, ecosystem.cargoTargetDirName),
  }
  const execute =
    run ?? ((cmd, args, stepEnv, stepCwd) => runCommand(cmd, args, stepEnv, stepCwd, wrapper))
  for (const step of steps) {
    try {
      await execute(step.cmd, step.args, env, cwd)
    } catch {
      throw new ServiceStartError('deps_failed')
    }
  }
  writeFileSync(join(cwd, RESTORE_MARKER), '')
}

/** 恢复命令行：与服务 `start` 同口径地把包装器前置（无包装器即原样）。 */
export function buildRestoreCommand(cmd: string, args: string[], wrapper?: string): string {
  // 命令路径可能含空格（自定义 node / 工具链）：含空格即加引号，否则 shell 会截断
  const exe = /\s/.test(cmd) ? `"${cmd}"` : cmd
  const line = `${exe} ${args.join(' ')}`
  return wrapper === undefined ? line : `${wrapper} ${line}`
}

/**
 * 缺省执行器：借 shell 解析命令行（与起服务同口径），构建输出直通宿主 stdio。
 * 必须借 shell：Windows 上 `npm` 是 `.cmd` 包装脚本，Node 的 `.cmd` 安全加固在 `shell:false`
 * 下直接抛 `EINVAL`，会让 npm 系恢复在 Windows 上必然失败。恢复命令的令牌全部来自
 * `plugin.json.build`，已过入世 shell 安全白名单，注入面在入世层已掐断。
 */
export function runCommand(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  wrapper?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(buildRestoreCommand(cmd, args, wrapper), {
      cwd,
      env,
      shell: true,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(signal !== null ? `signal:${signal}` : `exit:${code ?? 'unknown'}`))
    })
  })
}
