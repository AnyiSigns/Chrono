// 项二：宿主侧服务启动包装器（最小沙箱形态）。
// 覆盖：拼接纯函数（未配置零变化）、配置后 spawn 真走包装器（记录命令行 + 服务仍握手装载）、
// 宿主入口读 env、非法值 fail-closed 并记运维日志。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { composeStartCommand } from '../assembly/service-host.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { killProcessTree, readLifecycle, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

const HOST_MAIN = fileURLToPath(new URL('../main.ts', import.meta.url))

/** 记录命令行后原样执行原命令的包装脚本（跨平台：用 process.execPath 重放 argv）。 */
function writeRecordingWrapper(root: string, recordFile: string): string {
  const script = join(root, 'wrapper.js')
  writeFileSync(
    script,
    [
      "const fs = require('node:fs')",
      "const { spawnSync } = require('node:child_process')",
      `const RECORD = ${JSON.stringify(recordFile)}`,
      'const argv = process.argv.slice(2)',
      'fs.writeFileSync(RECORD, JSON.stringify(argv))',
      'const child = spawnSync(process.execPath, argv.slice(1), { stdio: "inherit" })',
      'process.exit(child.status === null ? 1 : child.status)',
      '',
    ].join('\n'),
  )
  return script
}

describe('服务启动包装器（宿主侧）', () => {
  let root: string
  const handles: HostHandle[] = []
  let child: ChildProcess | undefined

  beforeEach(() => {
    root = createTempRoot()
    handles.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 兜底停机
      }
    }
    handles.length = 0
    if (child !== undefined && child.pid !== undefined && child.exitCode === null) {
      await killProcessTree(child.pid)
    }
    child = undefined
    await cleanupTempRoot(root)
  })

  it('composeStartCommand：未配置零变化，配置后前置包装器', () => {
    expect(composeStartCommand('node execute/main.js')).toBe('node execute/main.js')
    expect(composeStartCommand('node execute/main.js', 'sandbox --profile p')).toBe(
      'sandbox --profile p node execute/main.js',
    )
  })

  it('配置后 spawn 走包装器：记录到原 start 命令行，且服务仍能握手装载', async () => {
    const recordFile = join(root, 'wrapper-record.json')
    const wrapper = writeRecordingWrapper(root, recordFile)
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-wrap',
      start: 'node execute/main.js',
      implements: ['toy.wrap'],
    })
    const report = runSeed(root, [{ name: 'toy-wrap', path: pkgRoot }])
    expect(report.ok).toBe(true)

    const handle = await startHost({ root, startWrapper: `node "${wrapper}"` })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const status = await client.status()
      expect(status.loaded.map((item) => item.id)).toContain('toy-wrap')
    } finally {
      client.close()
    }

    const recorded = JSON.parse(readFileSync(recordFile, 'utf8')) as string[]
    expect(recorded).toEqual(['node', 'execute/main.js'])
  }, 15_000)

  it('startHost 直接注入非法包装器：fail-closed 拒绝，不静默降级', async () => {
    await expect(startHost({ root, startWrapper: '   ' })).rejects.toThrow('bad_start_wrapper')
  })

  it('宿主入口读 CHRONO_START_WRAPPER：非法值 fail-closed、退出码 1、记 host.start_failed', async () => {
    child = spawn(process.execPath, [HOST_MAIN, '--root', root], {
      env: { ...process.env, CHRONO_START_WRAPPER: '   ' },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
    })
    const code = await new Promise<number | null>((resolve) => child?.once('exit', resolve))
    expect(code).toBe(1)
    const entries = readLifecycle(hostPaths(root).lifecycleFile)
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'host', event: 'start_failed', reason: 'bad_start_wrapper' }),
    )
    child = undefined
  }, 15_000)
})
