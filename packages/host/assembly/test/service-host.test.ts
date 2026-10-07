// 服务通道写端有界性（F-20）与「hello 前自发帧」有界缓冲按序投递（F-23）的受控复现：
// 用假流 / 假 worker 直接驱动通道，避免真实进程的非确定性；inproc 的启动期 emit 走端到端装配。

import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import type { Worker } from 'node:worker_threads'
import {
  MAX_OUTBOUND_FRAMES,
  MAX_PENDING_FRAMES,
  createStdioChannel,
  createWorkerChannel,
} from '../service-host.ts'
import { createFrameDecoder, encodeFrame } from '../../wire.ts'
import { startAssembly } from '../runtime.ts'
import type { AssemblyRuntimeHandle } from '../runtime.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Json, World } from '../../../kernel/index.ts'

class FakeStdin extends EventEmitter {
  readonly writes: Uint8Array[] = []
  accept = true
  write(chunk: Uint8Array): boolean {
    this.writes.push(chunk)
    return this.accept
  }
  end(): void {
    // 假流：无实际关闭动作
  }
}

interface FakeChild {
  child: ChildProcess
  stdout: EventEmitter
  stdin: FakeStdin
}

function fakeChild(): FakeChild {
  const stdout = new EventEmitter()
  const stdin = new FakeStdin()
  const child = { pid: 4242, stdout, stdin } as unknown as ChildProcess
  return { child, stdout, stdin }
}

function decodeAll(chunks: Uint8Array[]): Json[] {
  const decoder = createFrameDecoder()
  return chunks.flatMap((chunk) => decoder.push(Buffer.from(chunk)))
}

class FakeWorker extends EventEmitter {
  threadId = 1
  readonly posted: Json[] = []
  postMessage(message: Json): void {
    this.posted.push(message)
  }
  terminate(): void {
    // 假 worker：无实际终止动作
  }
}

describe('服务通道：写端有界与启动期缓冲', () => {
  it('stdio：hello 前到达的帧在消息回调注册前缓冲，注册后按原序投递', () => {
    const { child, stdout } = fakeChild()
    const channel = createStdioChannel(child)
    const first: Json = { v: '1', id: 'e1', kind: 'event', topic: 'ready', payload: { n: 1 } }
    const second: Json = { v: '1', id: 'e2', kind: 'event', topic: 'ready', payload: { n: 2 } }
    stdout.emit('data', Buffer.from(encodeFrame(first)))
    stdout.emit('data', Buffer.from(encodeFrame(second)))

    const received: Json[] = []
    channel.onMessage((message) => received.push(message))
    expect(received).toEqual([first, second])
  })

  it('stdio：回调注册前的入站帧超上限 → 按协议损坏收口，不无界缓冲', () => {
    const { child, stdout } = fakeChild()
    const channel = createStdioChannel(child)
    for (let i = 0; i < MAX_PENDING_FRAMES; i += 1) {
      stdout.emit('data', Buffer.from(encodeFrame({ v: '1', id: `e${i}`, kind: 'event' })))
    }
    const closed: string[] = []
    channel.onClose((reason) => closed.push(reason))
    stdout.emit('data', Buffer.from(encodeFrame({ v: '1', id: 'overflow', kind: 'event' })))
    expect(closed).toEqual(['protocol_error'])
  })

  it('stdio：静默消费端不追加 Writable 缓冲——等 drain 且帧序不变', () => {
    const { child, stdin } = fakeChild()
    const channel = createStdioChannel(child)
    stdin.accept = false
    channel.write({ id: 'a' })
    channel.write({ id: 'b' })
    // 首帧写入返回 false 后停写：第二帧排队、不再写 Writable
    expect(stdin.writes).toHaveLength(1)
    stdin.accept = true
    stdin.emit('drain')
    expect(stdin.writes).toHaveLength(2)
    expect(decodeAll(stdin.writes).map((frame) => (frame as { id: string }).id)).toEqual(['a', 'b'])
  })

  it('stdio：写端队列超上限 → 按 backpressure_limit 收口', () => {
    const { child, stdin } = fakeChild()
    const channel = createStdioChannel(child)
    stdin.accept = false
    channel.write({ id: 'first' })
    const closed: string[] = []
    channel.onClose((reason) => closed.push(reason))
    for (let i = 0; i <= MAX_OUTBOUND_FRAMES; i += 1) {
      try {
        channel.write({ id: `f${i}` })
      } catch {
        // 超限后 write 抛 channel_closed，与通道已关闭口径一致
      }
    }
    expect(closed).toEqual(['backpressure_limit'])
    expect(stdin.writes).toHaveLength(1)
  })

  it('worker：hello 前到达的帧在消息回调注册前缓冲，注册后按原序投递', () => {
    const worker = new FakeWorker()
    const channel = createWorkerChannel(worker as unknown as Worker)
    const message: Json = { v: '1', id: 'e1', kind: 'event', topic: 'ready', payload: null }
    worker.emit('message', message)
    const received: Json[] = []
    channel.onMessage((m) => received.push(m))
    expect(received).toEqual([message])
  })

  it('worker：在途帧超上限 fail-closed；收到服务帧后重置计数', () => {
    const worker = new FakeWorker()
    const channel = createWorkerChannel(worker as unknown as Worker)
    const closed: string[] = []
    channel.onClose((reason) => closed.push(reason))
    for (let i = 0; i < MAX_OUTBOUND_FRAMES; i += 1) channel.write({ id: `f${i}` })
    expect(worker.posted).toHaveLength(MAX_OUTBOUND_FRAMES)
    // 服务回一帧即证明消息循环在消费：在途清零，可继续投递
    worker.emit('message', { id: 'resp' })
    expect(() => channel.write({ id: 'after-reset' })).not.toThrow()
    // 再次沉默累积到上限即收口
    for (let i = 0; i < MAX_OUTBOUND_FRAMES - 1; i += 1) channel.write({ id: `g${i}` })
    expect(() => channel.write({ id: 'overflow' })).toThrow('channel_closed')
    expect(closed).toEqual(['backpressure_limit'])
  })
})

// inproc 工厂在构造期同步 emit：宿主消息回调此时尚未注册，修复前该启动期事件被静默丢弃。
const READY_SERVICE_MAIN = `import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

function manifest() {
  const plugin = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'plugin.json'), 'utf8'))
  return { v: '1', identity: plugin.identity, implements: plugin.implements, methods: plugin.methods, protocol: plugin.protocol, state: plugin.state }
}

export function createService(ctx) {
  ctx.emit({ v: '1', id: 'ready-1', kind: 'event', topic: 'ready', payload: { phase: 'init' } })
  return {
    receive(message) {
      if (message === null || typeof message !== 'object') return
      switch (message.kind) {
        case 'hello': ctx.emit(Object.assign({ id: message.id, kind: 'manifest' }, manifest())); return
        case 'probe': ctx.emit({ id: message.id, kind: 'pong', ok: true }); return
        case 'reload': ctx.emit({ v: '1', id: message.id, kind: 'ack' }); return
        case 'drain': ctx.emit({ v: '1', id: message.id, kind: 'bye' }); return
        case 'call': ctx.emit({ v: '1', id: message.id, kind: 'result', ok: true, value: null }); return
      }
    },
    close() {},
  }
}
`

describe('服务通道：inproc 启动期自发帧不丢', () => {
  const handles: AssemblyRuntimeHandle[] = []
  const roots: string[] = []

  beforeEach(() => {
    handles.length = 0
    roots.length = 0
  })

  afterEach(async () => {
    for (const handle of [...handles].reverse()) {
      try {
        await handle.stop()
      } catch {
        // 尽力停机
      }
    }
    handles.length = 0
    for (const dir of roots.splice(0)) await cleanupTempRoot(dir)
  })

  it('createService 构造期 emit 的帧在握手完成后仍被投递（onEvent 可见）', async () => {
    const root = createTempRoot()
    roots.push(root)
    const pkg = writeTempPackage(root, {
      identity: 'toy-ready',
      implements: ['toy.ready'],
      methods: { 'toy.ready': ['echo'] },
      start: 'execute/main.mjs',
      transport: 'inproc',
      files: { 'execute/main.mjs': READY_SERVICE_MAIN },
    })
    expect(runSeed(root, [{ name: 'toy-ready', path: pkg }]).ok).toBe(true)
    const world: World = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const events: Json[] = []
    const handle = await startAssembly({
      root,
      world,
      log: () => {},
      onEvent: (impl, topic, payload) => events.push({ impl, topic, payload } as unknown as Json),
    })
    handles.push(handle)
    expect(events).toContainEqual({
      impl: 'toy-ready',
      topic: 'ready',
      payload: { phase: 'init' },
    })
  }, 15000)
})
