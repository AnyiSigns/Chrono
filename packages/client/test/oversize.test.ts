// 客户端入站面异常收口：解码器抛错（帧超上限 / 坏 JSON）不得冒泡崩客户端进程，
// 应与宿主侧同构地断开连接、拒绝在途等待者。

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { connect, ClientError } from '../index.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'
import { MAX_FRAME_BYTES } from '../../host/wire.ts'

describe('客户端入站面异常收口', () => {
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

  it('收到超上限帧前缀 → 客户端不崩，在途请求以连接关闭收口', async () => {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket: Socket) => {
      // 等客户端发出第一帧再回坏帧，确保解码抛错时已有在途等待者
      socket.once('data', () => {
        const prefix = Buffer.alloc(4)
        prefix.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
        socket.write(prefix)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    const client = await connect({ root, timeoutMs: 2000 })
    // 解码抛错后应立刻断开并以 connection_closed 拒绝在途请求（而非等超时，更非崩进程）
    const failure = await client.status().then(
      () => null,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(ClientError)
    expect((failure as ClientError).code).toBe('connection_closed')
    expect(() => client.close()).not.toThrow()
  })
})
