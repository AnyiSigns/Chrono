// 早到结果缓冲：结果先于等待者到达时暂存，`close` 必须清空，避免长驻连接无界堆积。

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { connect, bufferedResultCount, ClientError } from '../index.ts'
import { encodeFrame } from '../frame.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'
import type { Json } from '../../kernel/index.ts'

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 读一帧请求的 id（客户端首帧必带 id），供回包对齐等待器。 */
function requestId(chunk: Buffer): string {
  const length = chunk.readUInt32BE(0)
  const body = JSON.parse(chunk.subarray(4, 4 + length).toString('utf8')) as { id: string }
  return body.id
}

describe('客户端早到结果缓冲', () => {
  let root: string | null = null
  let server: Server | null = null

  afterEach(async () => {
    if (server !== null) {
      const current = server
      server = null
      await new Promise<void>((resolve) => current.close(() => resolve()))
    }
    if (root !== null) {
      const current = root
      root = null
      await cleanupTempRoot(current)
    }
  })

  it('无人认领的结果入缓冲，close 后清空', async () => {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket) => {
      socket.write(
        encodeFrame({
          v: '1',
          id: 'r1',
          kind: 'result',
          run: 'run-leak',
          status: 'done',
          observations: [] as Json[],
        }),
      )
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    const client = await connect({ root, timeoutMs: 2000 })
    await waitFor(() => bufferedResultCount(client) === 1)
    expect(bufferedResultCount(client)).toBe(1)
    client.close()
    expect(bufferedResultCount(client)).toBe(0)
  })

  it('同批先入缓冲、后未知 kind 触发 failAll：awaitRun 立即 connection_closed（不等超时）', async () => {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const id = requestId(chunk)
        // 同一批：accepted → result（此时无等待者，入缓冲）→ 未知 kind（failAll 清空缓冲并断连）。
        socket.write(
          Buffer.concat([
            encodeFrame({ v: '1', id, kind: 'accepted', run: 'run-1' }),
            encodeFrame({
              v: '1',
              id: 'r1',
              kind: 'result',
              run: 'run-1',
              status: 'done',
              observations: [] as Json[],
            }),
            encodeFrame({ v: '1', id: 'x1', kind: 'mystery' }),
          ]),
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    // 超时设得远大于断言窗口：修复前会挂到超时（timeout），修复后立即 connection_closed。
    const client = await connect({ root, timeoutMs: 5000 })
    try {
      const outcome = await Promise.race([
        client.submit([]).then(
          () => 'resolved',
          (err: unknown) => err,
        ),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 1000)),
      ])
      expect(outcome).toBeInstanceOf(ClientError)
      expect((outcome as ClientError).code).toBe('connection_closed')
    } finally {
      client.close()
    }
  })
})
