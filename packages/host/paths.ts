// 宿主侧落盘布局：state/ 永不进世界，全部路径在此单点解析。
// 根目录由启动参数或环境给出，缺省当前工作目录。

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

export interface HostPaths {
  root: string
  stateDir: string
  worldDir: string
  runtimeDir: string
  sockDir: string
  assetsDir: string
  blobsDir: string
  pluginsDir: string
  materializedDir: string
  depsDir: string
  journalFile: string
  baseFile: string
  coldDir: string
  lockFile: string
  lifecycleFile: string
  pluginsFile: string
  secretsFile: string
}

/** 解析仓库根：显式参数 > `CHRONO_ROOT` > 当前工作目录。 */
export function resolveRoot(explicit?: string): string {
  const fromEnv = process.env['CHRONO_ROOT']
  return resolve(explicit ?? (fromEnv && fromEnv.length > 0 ? fromEnv : process.cwd()))
}

/** 由根目录派生全部宿主侧路径；不创建目录，只做纯计算。 */
export function hostPaths(root: string): HostPaths {
  const stateDir = resolve(root, 'state')
  const worldDir = resolve(stateDir, 'world')
  const runtimeDir = resolve(stateDir, 'runtime')
  const sockDir = resolve(stateDir, 'sock')
  return {
    root,
    stateDir,
    worldDir,
    runtimeDir,
    sockDir,
    assetsDir: resolve(stateDir, 'assets'),
    // 源码字节内容寻址区：与 assets 机械同构（64-hex、只增、离线 GC），保留策略不同
    blobsDir: resolve(stateDir, 'blobs'),
    // 插件 ③ 目录：`<id>/` 承载插件可重算产物，宿主统一 GC
    pluginsDir: resolve(stateDir, 'plugins'),
    materializedDir: resolve(runtimeDir, 'materialized'),
    depsDir: resolve(stateDir, 'deps'),
    journalFile: resolve(worldDir, 'journal.jsonl'),
    baseFile: resolve(worldDir, 'base.json'),
    coldDir: resolve(worldDir, 'cold'),
    lockFile: resolve(runtimeDir, 'lock.json'),
    lifecycleFile: resolve(stateDir, 'lifecycle.log'),
    pluginsFile: resolve(stateDir, 'plugins.json'),
    // 密钥本地存储面：不进世界、不参与重放
    secretsFile: resolve(stateDir, 'secrets.local.json'),
  }
}

/**
 * 入站面地址：POSIX 为 unix domain socket 文件，Windows 为 named pipe。
 * 管道名由根路径摘要派生，避免同机多仓库撞名。
 */
export function socketPath(root: string): string {
  if (process.platform === 'win32') {
    const digest = createHash('sha256').update(root).digest('hex').slice(0, 16)
    return `\\\\.\\pipe\\chrono-host-${digest}`
  }
  return resolve(root, 'state', 'sock', 'host.sock')
}
