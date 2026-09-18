// F7 验收（进程级）：`CHRONO_CALL_TIMEOUT_MS` 由 host/main.ts 读入并透传——
// 静默服务在 env 指定时长即超时（若常量 30s 生效，命令不会在断言窗口内返回）。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runSeed } from '../offline.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { killProcessTree, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

const HOST_MAIN = fileURLToPath(new URL('../main.ts', import.meta.url))

const RUN_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]

describe('F7 超时透出（宿主进程读 env）', () => {
  let root: string
  let child: ChildProcess | undefined

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(async () => {
    if (child !== undefined && child.pid !== undefined && child.exitCode === null) {
      await killProcessTree(child.pid)
    }
    child = undefined
    await cleanupTempRoot(root)
  })

  it('CHRONO_CALL_TIMEOUT_MS=400：静默服务 400ms 量级超时（而非 30s）', async () => {
    const silent = writeTempPackage(root, {
      identity: 'toy-silent',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      serviceConfig: { callMode: 'silent' },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-caller',
      pins: { 'toy.alpha': 'toy-silent' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'run.json': JSON.stringify(RUN_TERM) },
      commands: [{ name: 'toy-caller.run', entry: 'terms/run.json' }],
    })
    const report = runSeed(root, [
      { name: 'toy-silent', path: silent },
      { name: 'toy-caller', path: caller },
    ])
    expect(report.ok).toBe(true)

    // 只给 env（不给 CLI 参数）：证明环境默认真被宿主入口消费；生效值随启动行打印
    child = spawn(process.execPath, [HOST_MAIN, '--root', root], {
      env: { ...process.env, CHRONO_CALL_TIMEOUT_MS: '400' },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: root,
    })
    await new Promise<void>((resolve, reject) => {
      let text = ''
      child?.stdout?.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8')
        if (text.includes('call_timeout_ms=400')) resolve()
      })
      child?.once('exit', (code) => reject(new Error(`host exited early: ${code}`)))
    })

    const client = await connect({ root, timeoutMs: 3000 })
    let elapsed = 0
    try {
      const begin = Date.now()
      const result = await client.command('toy-caller.run')
      elapsed = Date.now() - begin
      expect(result.status).toBe('refused')
    } finally {
      await client.stop().catch(() => {})
    }
    // 按 env 的 400ms 超时（远小于常量 30s）；阈值只防机器抖动，不掩盖口径
    expect(elapsed).toBeGreaterThanOrEqual(300)
    expect(elapsed).toBeLessThan(5000)
  }, 15_000)
})
