// run 等待与普通请求超时分离：多轮 / 慢 run 由 `runTimeoutMs` 判，不被单帧请求超时误判，
// 结果正常回收、不滞留 `bufferedResults`。

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { connect } from '../index.ts'
import type { Client } from '../index.ts'
import { encodeFrame } from '../frame.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'
import type { Json } from '../../kernel/index.ts'

function requestId(chunk: Buffer): string {
  const length = chunk.readUInt32BE(0)
  const body = JSON.parse(chunk.subarray(4, 4 + length).toString('utf8')) as { id: string }
  return body.id
}

/** 早到结果缓冲探针：run 结果被等待者认领后应为空。 */
function bufferedResultCount(client: Client): number {
  return (client as unknown as { bufferedResults: Map<string, unknown> }).bufferedResults.size
}

describe('客户端 run 等待超时', () => {
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

  it('慢 run 超过请求超时但在 run 超时内 → 正常返回，结果不滞留', async () => {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    const DELAY_MS = 150
    server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const id = requestId(chunk)
        socket.write(encodeFrame({ v: '1', id, kind: 'accepted', run: 'run-slow' }))
        setTimeout(() => {
          socket.write(
            encodeFrame({
              v: '1',
              kind: 'result',
              run: 'run-slow',
              status: 'done',
              observations: [] as Json[],
            }),
          )
        }, DELAY_MS)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    // 请求超时远小于 run 时长：修复前 run 等待复用请求超时会被误判 timeout。
    const client = await connect({ root, timeoutMs: 50, runTimeoutMs: 2000 })
    try {
      const started = Date.now()
      const result = await client.submit([])
      expect(result.status).toBe('done')
      expect(Date.now() - started).toBeGreaterThanOrEqual(DELAY_MS)
      // 结果被等待者认领：不留在早到缓冲里
      expect(bufferedResultCount(client)).toBe(0)
    } finally {
      client.close()
    }
  })

  it('run 超过 run 超时 → timeout（run 超时确实生效）', async () => {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => {
        const id = requestId(chunk)
        socket.write(encodeFrame({ v: '1', id, kind: 'accepted', run: 'run-hang' }))
        // 永不发 result
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    const client = await connect({ root, timeoutMs: 2000, runTimeoutMs: 60 })
    try {
      const outcome = await client.submit([]).then(
        () => 'resolved',
        (err: unknown) => err,
      )
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as { code?: string }).code).toBe('timeout')
    } finally {
      client.close()
    }
  })
})
