// 建连超时：对端既不触发 connect 也不触发 error 时，connect 必须按 timeoutMs 拒绝，
// 不得永久挂起。真实命名管道难以构造「接受但不完成」，故以桩替换 node:net 的 connect。

import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'

const fakeConnect = vi.hoisted(() => vi.fn<() => Socket>())

vi.mock('node:net', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:net')>()
  return { ...actual, connect: fakeConnect }
})

import { connect, ClientError } from '../index.ts'

/** 挂起 socket：永不 emit connect / error，仅支持 setTimeout / write / destroy / on。 */
function hangingSocket(): Socket {
  let timer: NodeJS.Timeout | null = null
  const emitter = new EventEmitter() as unknown as EventEmitter & {
    setTimeout: (ms: number, callback?: () => void) => unknown
    write: () => boolean
    destroy: () => void
  }
  emitter.setTimeout = (ms, callback) => {
    if (ms > 0 && callback !== undefined) timer = setTimeout(callback, ms)
    return emitter
  }
  emitter.write = () => true
  emitter.destroy = () => {
    if (timer !== null) clearTimeout(timer)
  }
  return emitter as unknown as Socket
}

describe('客户端建连超时', () => {
  it('对端不触发 connect / error → 以 connect_timeout 拒绝', async () => {
    fakeConnect.mockImplementation(() => hangingSocket())
    const failure = await connect({ root: 'C:/nowhere', timeoutMs: 25 }).then(
      () => null,
      (err: unknown) => err,
    )
    expect(failure).toBeInstanceOf(ClientError)
    expect((failure as ClientError).code).toBe('connect_timeout')
  })
})
