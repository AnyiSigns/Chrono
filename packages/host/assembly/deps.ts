// 依赖恢复：插件包入世只带源码 + 依赖清单，`node_modules` / `target/` / 原生扩展等
// 编译产物与依赖目录走宿主侧依赖缓存，物化时按清单重建。
// 宿主只认清单文件的存在性，不解释语言语义；命令执行由调用方注入，便于单测。

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ServiceStartError } from './supervision.ts'

/** 一步依赖恢复：要执行的命令与参数；具体工具链由清单文件决定。 */
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

/** npm 锁文件：命中即用 `npm ci` 保证可复现（v1 宿主只跑 npm）。 */
const NPM_LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json']

/** 其它生态锁文件：命中只说明需要安装；v1 宿主不认这些包管理器，回落 `npm install`。 */
const OTHER_LOCK_FILES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb']

/** 恢复完成标记：写在物化目录内，标记「本目录的清单已全部恢复」，不属于源码树、不进世界。 */
const RESTORE_MARKER = '.chrono-deps-ok'

/**
 * 规划某物化目录的依赖恢复步骤（纯函数，只读文件系统）。
 * 以恢复完成标记为准：有标记说明本目录恢复过，跳过全部步骤；
 * 无标记则按清单产全部适用步骤（即使已有 `node_modules`——半恢复无法自愈，必须重跑）。
 * 顺序 Node → Rust → 原生：原生扩展常需 Node 依赖就位后再编译。
 */
export function planDependencyRestore(cwd: string): RestoreStep[] {
  if (existsSync(join(cwd, RESTORE_MARKER))) return []
  const steps: RestoreStep[] = []
  const node = planNodeStep(cwd)
  if (node !== null) steps.push(node)
  if (existsSync(join(cwd, 'Cargo.toml'))) {
    steps.push({ cmd: 'cargo', args: ['build', '--release'] })
  }
  if (existsSync(join(cwd, 'binding.gyp'))) {
    steps.push({ cmd: 'npm', args: ['rebuild'] })
  }
  return steps
}

/**
 * Node 恢复步骤：有依赖声明或任一锁文件才需要；npm 锁文件用 `npm ci`，其余锁文件用 `npm install`。
 * 无依赖声明的 toy 包返回 null，避免给每个插件都白跑一次 npm。
 */
function planNodeStep(cwd: string): RestoreStep | null {
  if (!existsSync(join(cwd, 'package.json'))) return null
  const npmLocked = NPM_LOCK_FILES.some((name) => existsSync(join(cwd, name)))
  const anyLocked = npmLocked || OTHER_LOCK_FILES.some((name) => existsSync(join(cwd, name)))
  if (!anyLocked && !hasDeclaredDeps(cwd)) return null
  const subcommand = npmLocked ? 'ci' : 'install'
  return { cmd: 'npm', args: [subcommand, '--no-audit', '--no-fund'] }
}

/** 读取 package.json 的三类依赖字段；缺失或畸形一律按「无声明」处理（fail-safe）。 */
function hasDeclaredDeps(cwd: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
  } catch {
    return false
  }
  if (typeof parsed !== 'object' || parsed === null) return false
  const record = parsed as Record<string, unknown>
  return ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
    const value = record[key]
    return typeof value === 'object' && value !== null && Object.keys(value).length > 0
  })
}

/**
 * 按计划执行依赖恢复；任一步失败即抛 `ServiceStartError('deps_failed')`。
 * 缓存目录指向宿主侧 `depsDir`，使多次物化共享下载与编译产物。
 * `wrapper` 与服务 `start` 同路前置：依赖安装会执行插件声明的 lifecycle 脚本，
 * 必须与起服务走同一沙箱包装，否则恢复阶段成了绕过沙箱的口子。
 * 全部步骤成功后写恢复完成标记；任一步失败不写，下次启动重试（半恢复无法自愈）。
 */
export async function restoreDependencies(
  cwd: string,
  depsDir: string,
  run?: DependencyRunner,
  wrapper?: string,
): Promise<void> {
  const steps = planDependencyRestore(cwd)
  if (steps.length === 0) return
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_cache: join(depsDir, 'npm'),
    // npm 12 默认 allow-remote=none，会让含依赖插件的 npm ci 拒绝拉取远端包而 deps_failed
    npm_config_allow_remote: 'all',
    CARGO_TARGET_DIR: join(depsDir, 'cargo-target'),
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
 * 下直接抛 `EINVAL`，会让 npm 系恢复在 Windows 上必然失败。参数均为本模块常量，无注入面。
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
