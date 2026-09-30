// `putAsset` 入口 8 MiB 前置校验：恰好 8 MiB 正常发送；超 1 字节即抛 `asset_too_large`，
// 不再退化到帧上限的 `connection_closed` / 断连。

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { connect, ClientError } from '../index.ts'
import { createFrameDecoder, encodeFrame } from '../frame.ts'
import { MAX_ASSET_BYTES as CLIENT_MAX_ASSET_BYTES } from '../protocol.ts'
import { MAX_ASSET_BYTES as HOST_MAX_ASSET_BYTES } from '../../host/assets.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'
import type { Json } from '../../kernel/index.ts'

describe('客户端 putAsset 8 MiB 前置校验', () => {
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

  it('客户端上限常量与宿主同口径（防两侧漂移）', () => {
    expect(CLIENT_MAX_ASSET_BYTES).toBe(HOST_MAX_ASSET_BYTES)
  })

  it('恰好 8 MiB 发送成功；超 1 字节抛 asset_too_large 且连接不断', async () => {
    const frames: Json[] = []
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket) => {
      const decoder = createFrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          frames.push(raw)
          const frame = raw as unknown as { id: string; kind: string }
          if (frame.kind === 'asset.put') {
            socket.write(
              encodeFrame({
                v: '1',
                id: frame.id,
                kind: 'asset.ref',
                ref: { kind: 'asset', sha256: 'a'.repeat(64), mime: 'text/plain', size: 0 },
              }),
            )
          } else if (frame.kind === 'status') {
            socket.write(
              encodeFrame({
                v: '1',
                id: frame.id,
                kind: 'state',
                world_head: { seq: -1, hash: null },
                world_rev: 'rev',
                loaded: [],
              }),
            )
          }
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })

    const client = await connect({ root, timeoutMs: 5000 })
    try {
      const atLimit = await client.putAsset('text/plain', new Uint8Array(CLIENT_MAX_ASSET_BYTES))
      expect(atLimit.sha256).toBe('a'.repeat(64))

      const framesBefore = frames.length
      const failure = await client
        .putAsset('text/plain', new Uint8Array(CLIENT_MAX_ASSET_BYTES + 1))
        .then(
          () => null,
          (err: unknown) => err,
        )
      expect(failure).toBeInstanceOf(ClientError)
      expect((failure as ClientError).code).toBe('asset_too_large')
      // 超限帧根本没发出：服务端帧数不变
      expect(frames.length).toBe(framesBefore)

      // 连接未被 destroy：同一客户端仍可正常往返
      const status = await client.status()
      expect(status.world_rev).toBe('rev')
    } finally {
      client.close()
    }
  })
})
