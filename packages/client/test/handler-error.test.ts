// 用户事件 handler 抛错只影响自身：不得冒成未捕获异常崩进程，也不得阻断后续 handler。
import { describe, expect, it, afterEach, vi } from 'vitest'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { connect } from '../index.ts'
import type { EventMessage } from '../index.ts'
import { encodeFrame } from '../frame.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'

/** 读一帧请求的 id（客户端首帧必带 id），供回包对齐等待器。 */
function requestId(chunk: Buffer): string {
  const length = chunk.readUInt32BE(0)
  const body = JSON.parse(chunk.subarray(4, 4 + length).toString('utf8')) as { id: string }
  return body.id
}

describe('客户端事件 handler 异常隔离', () => {
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

  it('handler 抛错不崩进程、不阻断后续 handler，且被记录', async () => {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket: Socket) => {
      socket.once('data', (chunk: Buffer) => {
        const id = requestId(chunk)
        socket.write(
          encodeFrame({ v: '1', impl: 'toy', kind: 'event', topic: 't', payload: { n: 1 } }),
        )
        socket.write(
          encodeFrame({ v: '1', impl: 'toy', kind: 'event', topic: 't', payload: { n: 2 } }),
        )
        socket.write(
          encodeFrame({
            v: '1',
            id,
            kind: 'state',
            world_head: { seq: -1, hash: null },
            world_rev: 'x',
            loaded: [],
          }),
        )
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    const seen: EventMessage[] = []
    const recorded: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      recorded.push(args)
    })
    let uncaught = 0
    const onUncaught = (): void => {
      uncaught += 1
    }
    process.on('uncaughtException', onUncaught)

    const client = await connect({ root, timeoutMs: 2000 })
    try {
      client.onEvent(() => {
        throw new Error('boom')
      })
      client.onEvent((event) => seen.push(event))
      await client.status() // 触发服务端回事件；state 回包令等待器收口
      expect(seen.map((e) => (e.payload as { n: number }).n)).toEqual([1, 2])
      expect(recorded.length).toBe(2)
      expect(uncaught).toBe(0)
    } finally {
      process.off('uncaughtException', onUncaught)
      spy.mockRestore()
      expect(() => client.close()).not.toThrow()
    }
  })
})
