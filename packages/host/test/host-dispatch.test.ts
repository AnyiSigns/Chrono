// 入站派发收口：未知 kind 不静默无响应；stop 受理后同一批的 run 请求立即被拒
// （stop 经 setImmediate 延迟执行，窗口内不得再受理新 run）。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { connect as netConnect } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { hostPaths, socketPath } from '../paths.ts'
import { readJournal } from '../ledger/index.ts'
import { createFrameDecoder, encodeFrame } from '../wire.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import type { Json } from '../../kernel/index.ts'

/** 把多条帧拼成一次写入（保证服务端同一 chunk 内按序派发），收集回帧直到 predicate 为真（或超时）。 */
function rawCollect(
  root: string,
  messages: Json[],
  done: (frames: Json[]) => boolean,
  timeoutMs = 4000,
): Promise<Json[]> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath(root))
    const decoder = createFrameDecoder()
    const frames: Json[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(frames)
    }, timeoutMs)
    socket.on('connect', () => {
      socket.write(Buffer.concat(messages.map((message) => Buffer.from(encodeFrame(message)))))
    })
    socket.on('data', (chunk) => {
      frames.push(...decoder.push(chunk))
      if (done(frames)) {
        clearTimeout(timer)
        socket.destroy()
        resolve(frames)
      }
    })
    // 停机路径会销毁客户端：连接关闭即以已收帧收口（不得依赖被停机吞掉的末帧）
    socket.on('close', () => {
      clearTimeout(timer)
      resolve(frames)
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('入站派发收口', () => {
  let root: string
  const handles: HostHandle[] = []

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
    await cleanupTempRoot(root)
  })

  it('未知 kind → error{bad_directive}，不静默无响应', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const frames = await rawCollect(root, [{ v: '1', id: 'x1', kind: 'bogus' }], (all) =>
      all.some((frame) => isRecord(frame) && frame['kind'] === 'error'),
    )
    const error = frames.find((frame) => isRecord(frame) && frame['kind'] === 'error')
    expect(error).toBeDefined()
    expect(error).toMatchObject({ id: 'x1', code: 'bad_directive' })
    expect(String((error as { message?: Json }).message)).toContain('bogus')
  })

  it('stop 受理后同一批的 submit 不被受理（setImmediate 窗口不误起 run）', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    // stop 与 submit 同一 chunk 按序派发：stop 同步置 stopping，submit 随即被挡（不再起 run）。
    // 停机销毁客户端会吞掉回帧，故以「是否落账」为判据：修复前 submit 会在置位前被受理并抢先落一条写。
    await rawCollect(
      root,
      [
        { v: '1', id: 's1', kind: 'stop' },
        {
          v: '1',
          id: 's2',
          kind: 'submit',
          directives: [
            {
              kind: 'write',
              request: {
                id: 'w-window',
                op: 'put',
                target: { expect_pos: null },
                args: { body: { v: 1 } },
                by: 'client',
              },
            },
          ],
        },
      ],
      () => false,
    )
    // 等停机序列落定（锁释放）后再读账本
    const journalFile = join(root, 'state', 'world', 'journal.jsonl')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(existsSync(hostPaths(root).lockFile)).toBe(false)
    expect(readJournal(journalFile)).toEqual([])
  })
})
