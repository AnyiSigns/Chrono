import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { runSeed, runVerify, runReplay } from '../../host/index.ts'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../../host/test/test-helpers.ts'
import { killProcessTree } from '../../host/test/test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

const BOOT_MAIN = fileURLToPath(new URL('../main.ts', import.meta.url))

/** 跑一次 boot CLI 并收集输出（start 会派生宿主，另行停机）。 */
function runBoot(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BOOT_MAIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
  })
}

/** 令运行中的宿主停机，并等到入站面不再可连（锁必已释放）。 */
async function stopHost(root: string): Promise<void> {
  try {
    const client = await connect({ root, timeoutMs: 1000 })
    await client.stop()
  } catch {
    // 宿主未运行：无需停机
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      const client = await connect({ root, timeoutMs: 300 })
      client.close()
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    } catch {
      return
    }
  }
}

describe('CLI 薄壳 boot', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
    createToyPlugin(root)
    const { writeFileSync } = require('node:fs')
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy', path: join(root, 'pkg', 'toy') }]),
    )
  })

  afterEach(() => cleanupTempRoot(root))

  it('seed 入世 toy 插件', () => {
    const report = runSeed(root)
    expect(report.ok).toBe(true)
    const toy = report.items.find((i) => i.name === 'toy')
    expect(toy).toBeDefined()
    expect(toy!.status).toBe('seeded')
  })

  it('verify 校验通过', () => {
    runSeed(root)
    const report = runVerify(root)
    expect(report.ok).toBe(true)
    expect(report.head!.seq).toBeGreaterThanOrEqual(0)
  })

  it('replay 重建世界，worldRev 非空', () => {
    runSeed(root)
    const report = runReplay(root)
    expect(report.head.seq).toBeGreaterThanOrEqual(0)
    expect(typeof report.worldRev).toBe('string')
    expect(report.worldRev).toHaveLength(64)
  })

  it('start 打印生效超时（CLI 覆盖 env，缺省读 env）', async () => {
    const started: number[] = []
    try {
      // 显式 CLI 覆盖 env（优先级：CLI > env）
      const cli = await runBoot(['start', '--root', root, '--call-timeout-ms', '1234'], {
        CHRONO_CALL_TIMEOUT_MS: '2222',
      })
      expect(cli.code).toBe(0)
      const first = JSON.parse(cli.stdout) as { pid: number; call_timeout_ms: number }
      expect(first.call_timeout_ms).toBe(1234)
      started.push(first.pid)
      await stopHost(root)

      // 只给 env：打印 env 生效值
      const envOnly = await runBoot(['start', '--root', root], {
        CHRONO_CALL_TIMEOUT_MS: '2222',
      })
      expect(envOnly.code).toBe(0)
      const second = JSON.parse(envOnly.stdout) as { pid: number; call_timeout_ms: number }
      expect(second.call_timeout_ms).toBe(2222)
      started.push(second.pid)
    } finally {
      await stopHost(root)
      for (const pid of started) await killProcessTree(pid)
    }
  })

  it('compact：离线压缩（空世界也成立）', async () => {
    const result = await runBoot(['compact', '--root', root])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as { snapshot: { seq: number }; moved: number }
    expect(report.snapshot.seq).toBe(0)
    expect(report.moved).toBe(0)
    expect(existsSync(join(root, 'state', 'world', 'base.json'))).toBe(true)
  })

  it('assets gc：回收无引用字节（离线 CLI 命令）', async () => {
    const assetsDir = join(root, 'state', 'assets')
    mkdirSync(assetsDir, { recursive: true })
    const orphan = 'a'.repeat(64)
    writeFileSync(join(assetsDir, orphan), 'orphan')
    const result = await runBoot(['assets', 'gc', '--root', root])
    expect(result.code).toBe(0)
    const report = JSON.parse(result.stdout) as { removed: string[]; kept: number }
    expect(report.removed).toEqual([orphan])
    expect(report.kept).toBe(0)
    expect(existsSync(join(assetsDir, orphan))).toBe(false)
  })

  it('start 非法超时 → 退出码 1、报 bad_call_timeout、不起宿主', async () => {
    const bad = await runBoot(['start', '--root', root, '--call-timeout-ms', 'abc'])
    expect(bad.code).toBe(1)
    expect(bad.stderr).toContain('bad_call_timeout')
    expect(bad.stdout).toBe('')
  })
})
