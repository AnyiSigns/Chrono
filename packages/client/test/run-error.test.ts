// 受理（accepted）后到达的 error{id} 必须映射回该 run，以真实错误码 reject，
// 而不是因 id 等待器已被 accepted 消费而静默丢弃、最终落成 timeout。

import { describe, expect, it, afterEach } from 'vitest'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { connect, ClientError } from '../index.ts'
import { encodeFrame } from '../frame.ts'
import { resolveRoot, socketPath } from '../socket.ts'
import { createTempRoot, cleanupTempRoot } from '../../host/test/test-helpers.ts'

function requestId(chunk: Buffer): string {
  const length = chunk.readUInt32BE(0)
  const body = JSON.parse(chunk.subarray(4, 4 + length).toString('utf8')) as { id: string }
  return body.id
}

describe('客户端 accepted 后的 error 帧映射', () => {
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

  async function listen(
    onData: (socket: import('node:net').Socket, id: string) => void,
  ): Promise<string> {
    root = createTempRoot()
    const address = socketPath(resolveRoot(root))
    server = createServer((socket) => {
      socket.once('data', (chunk: Buffer) => onData(socket, requestId(chunk)))
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(address, () => resolve())
    })
    return root
  }

  it('同批 accepted + error{id} → 以真实错误码 reject（不等超时）', async () => {
    const r = await listen((socket, id) => {
      socket.write(
        Buffer.concat([
          encodeFrame({ v: '1', id, kind: 'accepted', run: 'run-err' }),
          encodeFrame({ v: '1', id, kind: 'error', code: 'internal', message: 'run failed' }),
        ]),
      )
    })
    const client = await connect({ root: r, timeoutMs: 5000 })
    try {
      const outcome = await client.submit([]).then(
        () => null,
        (err: unknown) => err,
      )
      expect(outcome).toBeInstanceOf(ClientError)
      expect((outcome as ClientError).code).toBe('internal')
      expect((outcome as ClientError).message).toContain('run failed')
    } finally {
      client.close()
    }
  })

  it('accepted 后延迟到达的 error{id} → 映射到 run 真实错误码', async () => {
    const r = await listen((socket, id) => {
      socket.write(encodeFrame({ v: '1', id, kind: 'accepted', run: 'run-err-2' }))
      setTimeout(() => {
        socket.write(encodeFrame({ v: '1', id, kind: 'error', code: 'internal', message: 'boom' }))
      }, 30)
    })
    const client = await connect({ root: r, timeoutMs: 5000 })
    try {
      const outcome = await client.submit([]).then(
        () => null,
        (err: unknown) => err,
      )
      expect(outcome).toBeInstanceOf(ClientError)
      expect((outcome as ClientError).code).toBe('internal')
    } finally {
      client.close()
    }
  })

  it('未受理即 error{id} → 仍走普通 id 等待器（错误码不变）', async () => {
    const r = await listen((socket, id) => {
      socket.write(
        encodeFrame({ v: '1', id, kind: 'error', code: 'bad_directive', message: 'nope' }),
      )
    })
    const client = await connect({ root: r, timeoutMs: 5000 })
    try {
      const outcome = await client.submit([]).then(
        () => null,
        (err: unknown) => err,
      )
      expect(outcome).toBeInstanceOf(ClientError)
      expect((outcome as ClientError).code).toBe('bad_directive')
    } finally {
      client.close()
    }
  })
})
