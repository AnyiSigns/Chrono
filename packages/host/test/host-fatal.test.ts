// 落账致命态接停机：账本追加失败（内存世界已与磁盘账本分叉）后，run 收口标记致命，
// 宿主按停机序列收口（stop 幂等）；继续服务只会让分叉随每轮提交放大。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { resetFatal } from '../effect/fatal.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { readLifecycle, waitFor, waitForLifecycle } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

describe('落账致命态接停机', () => {
  let root: string
  const handles: HostHandle[] = []

  beforeEach(() => {
    root = createTempRoot()
    handles.length = 0
    resetFatal()
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
    // 致命态是进程级：复位，避免污染同文件其余用例
    resetFatal()
    await cleanupTempRoot(root)
  })

  it('appendJournal 抛错 → 宿主标记致命并停机（stop 幂等）', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    // 把账本路径换成目录：appendJournal 的 writeSync 必抛 EISDIR（跨平台确定性故障）
    const journalFile = join(root, 'state', 'world', 'journal.jsonl')
    if (existsSync(journalFile)) rmSync(journalFile, { force: true })
    mkdirSync(journalFile, { recursive: true })

    const client = await connect({ root, timeoutMs: 3000 })
    try {
      // 纯 write run：done 轮触发 onRound → appendJournal 失败 → 致命 → 停机
      await client
        .submit([
          {
            kind: 'write',
            request: {
              id: 'fatal-w1',
              op: 'put',
              target: { expect_pos: null },
              args: { body: { v: 1 } },
              by: 'client',
            },
          },
        ])
        .catch(() => undefined)
    } finally {
      client.close()
    }

    await waitForLifecycle(
      hostPaths(root).lifecycleFile,
      (entry) => entry.event === 'persist_fatal_stop',
      'persist_fatal_stop',
    )
    // 致命即停机：锁被释放；重复 stop() 幂等共享同一 promise
    await waitFor(() => !existsSync(hostPaths(root).lockFile), 'lock released')
    const failed = readLifecycle(hostPaths(root).lifecycleFile).filter(
      (entry) => entry.event === 'run_failed',
    )
    expect(failed.length).toBeGreaterThanOrEqual(1)
    await handle.stop()
  })
})
