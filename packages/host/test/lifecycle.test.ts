// 运维日志落点：批量缓冲的落盘时机、顺序 / 格式不变、停机排空与退出兜底。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import {
  LIFECYCLE_FLUSH_BYTES,
  LIFECYCLE_FLUSH_INTERVAL_MS,
  appendLifecycle,
  flushLifecycleSync,
} from '../lifecycle.ts'
import { canonicalJson } from '../../kernel/index.ts'
import type { Json } from '../../kernel/index.ts'

function readLines(file: string): string[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

describe('运维日志批量落盘', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = join(tmpdir(), 'chrono-lifecycle', randomUUID())
    file = join(dir, 'state', 'lifecycle.log')
  })

  afterEach(async () => {
    // 关闭本进程持有的句柄，避免 Windows 上占用临时目录
    flushLifecycleSync()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('多条事件按序落盘，逐行等于 canonicalJson + 换行', () => {
    const events: Json[] = [
      { at: 1, kind: 'host', event: 'start' },
      { at: 2, kind: 'host', event: 'watch_start', reason: '3' },
      { at: 3, kind: 'dep', event: 'drift', impl: 'toy', cap: 'p', gen: 'g' },
      { at: 4, kind: 'service', event: 'exit', impl: 'toy', reason: 'superseded' },
      { at: 5, kind: 'handshake', event: 'failed', impl: 'bad' },
    ]
    for (const event of events) appendLifecycle(file, event)
    flushLifecycleSync(file)

    const lines = readLines(file)
    expect(lines).toEqual(events.map((event) => canonicalJson(event)))
    expect(lines.map((line) => (JSON.parse(line) as { event: string }).event)).toEqual([
      'start',
      'watch_start',
      'drift',
      'exit',
      'failed',
    ])
  })

  it('无显式 flush 时在文档间隔内自动落盘', async () => {
    const started = Date.now()
    appendLifecycle(file, { at: 1, kind: 'host', event: 'timer_probe' })
    let seen = false
    while (Date.now() - started < LIFECYCLE_FLUSH_INTERVAL_MS + 1500) {
      if (readLines(file).length > 0) {
        seen = true
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(seen).toBe(true)
    expect(Date.now() - started).toBeLessThan(LIFECYCLE_FLUSH_INTERVAL_MS + 1500)
  })

  it('累计字节达到阈值即立即落盘（不等定时窗口）', () => {
    const bulk = 'x'.repeat(32 * 1024)
    appendLifecycle(file, { at: 1, kind: 'host', event: 'bulk_a', reason: bulk })
    // 单条未达阈值：仍留在缓冲里
    expect(readLines(file)).toEqual([])
    appendLifecycle(file, { at: 2, kind: 'host', event: 'bulk_b', reason: bulk })
    // 两条累计越过 LIFECYCLE_FLUSH_BYTES：同步落盘
    expect(readLines(file).length).toBe(2)
    expect(LIFECYCLE_FLUSH_BYTES).toBeLessThanOrEqual(64 * 1024)
  })

  it('flushLifecycleSync 排空全部待写缓冲', () => {
    for (let i = 0; i < 4; i += 1) {
      appendLifecycle(file, { at: i, kind: 'host', event: `evt_${i}` })
    }
    expect(readLines(file)).toEqual([])
    flushLifecycleSync(file)
    const events = readLines(file).map((line) => (JSON.parse(line) as { event: string }).event)
    expect(events).toEqual(['evt_0', 'evt_1', 'evt_2', 'evt_3'])
  })

  it('进程正常退出（无显式 flush）由 exit 兜底排空，事件不丢', async () => {
    const lifecycleUrl = new URL('../lifecycle.ts', import.meta.url).href
    const script = [
      `import { appendLifecycle } from ${JSON.stringify(lifecycleUrl)};`,
      `appendLifecycle(${JSON.stringify(file)}, { at: 1, kind: 'host', event: 'one' });`,
      `appendLifecycle(${JSON.stringify(file)}, { at: 2, kind: 'host', event: 'two' });`,
    ].join('\n')
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
    expect(stderr).toBe('')
    expect(code).toBe(0)
    const events = readLines(file).map((line) => (JSON.parse(line) as { event: string }).event)
    expect(events).toEqual(['one', 'two'])
  })
})
