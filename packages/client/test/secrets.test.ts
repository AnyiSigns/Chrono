// 密钥本地存储面：`putSecret` / `deleteSecret` 按入站动词发帧，等待 `secrets.ok` 收口；
// 错误帧沿用既有 ClientError 路径。

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { connect, ClientError } from '../index.ts'
import { createFrameDecoder, encodeFrame } from '../frame.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'

interface CapturedFrame {
  id: string
  kind: string
  name?: string
  value?: string
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('客户端密钥本地存储面', () => {
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

  async function listen(handler: (socket: Socket) => void): Promise<string> {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer(handler)
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })
    return root
  }

  it('putSecret 发出 secrets.put 帧，收到 secrets.ok 后才 resolve', async () => {
    const frames: CapturedFrame[] = []
    let reply: (() => void) | null = null
    const hostRoot = await listen((socket) => {
      const decoder = createFrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const frame = raw as unknown as CapturedFrame
          frames.push(frame)
          reply = () =>
            socket.write(
              encodeFrame({ v: '1', id: frame.id, kind: 'secrets.ok', name: frame.name! }),
            )
        }
      })
    })

    const client = await connect({ root: hostRoot, timeoutMs: 2000 })
    try {
      let resolved = false
      const pending = client.putSecret('API_KEY', 'sk-1').then(() => {
        resolved = true
      })
      await waitFor(() => frames.length === 1)
      expect(frames[0]!.kind).toBe('secrets.put')
      expect(frames[0]!.name).toBe('API_KEY')
      expect(frames[0]!.value).toBe('sk-1')
      expect(typeof frames[0]!.id).toBe('string')
      // 未收到 secrets.ok 前不得 resolve
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(resolved).toBe(false)
      reply!()
      await pending
      expect(resolved).toBe(true)
    } finally {
      client.close()
    }
  })

  it('deleteSecret 发出 secrets.delete 帧，收到 secrets.ok 后 resolve', async () => {
    const frames: CapturedFrame[] = []
    let reply: (() => void) | null = null
    const hostRoot = await listen((socket) => {
      const decoder = createFrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const frame = raw as unknown as CapturedFrame
          frames.push(frame)
          reply = () =>
            socket.write(
              encodeFrame({ v: '1', id: frame.id, kind: 'secrets.ok', name: frame.name! }),
            )
        }
      })
    })

    const client = await connect({ root: hostRoot, timeoutMs: 2000 })
    try {
      const pending = client.deleteSecret('API_KEY')
      await waitFor(() => frames.length === 1)
      expect(frames[0]!.kind).toBe('secrets.delete')
      expect(frames[0]!.name).toBe('API_KEY')
      expect(frames[0]!.value).toBeUndefined()
      reply!()
      await pending
    } finally {
      client.close()
    }
  })

  it('错误帧映射为 ClientError（沿用既有错误路径）', async () => {
    const hostRoot = await listen((socket) => {
      const decoder = createFrameDecoder()
      socket.on('data', (chunk: Buffer) => {
        for (const raw of decoder.push(chunk)) {
          const frame = raw as unknown as { id: string }
          socket.write(
            encodeFrame({
              v: '1',
              id: frame.id,
              kind: 'error',
              code: 'bad_directive',
              message: 'secrets.put expects { name, value }',
            }),
          )
        }
      })
    })

    const client = await connect({ root: hostRoot, timeoutMs: 2000 })
    try {
      const failure = await client.putSecret('', 'x').then(
        () => null,
        (err: unknown) => err,
      )
      expect(failure).toBeInstanceOf(ClientError)
      expect((failure as ClientError).code).toBe('bad_directive')
    } finally {
      client.close()
    }
  })
})
