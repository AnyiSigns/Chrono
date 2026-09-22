import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { createServer, connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { acquireLock, loadAnchor, releaseLock } from '../ledger/index.ts'
import { materializeCommit } from '../assembly/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import {
  FIXTURE_ALPHA,
  FIXTURE_BETA,
  FIXTURE_SERVICE_MAIN,
  isPidAlive,
  readLifecycle,
  waitFor,
  waitForLifecycle,
  writeTempPackage,
} from './test-helpers-ext.ts'
import { hostPaths, socketPath } from '../paths.ts'
import { createFrameDecoder, encodeFrame } from '../wire.ts'
import { connect } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

describe('宿主集成（入站面）', () => {
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
        // 兜底停机：绝不留下子进程 / 锁
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  async function host(extra: (handle: HostHandle) => Promise<void>): Promise<void> {
    const handle = await startHost({ root })
    handles.push(handle)
    await extra(handle)
  }

  function rawConnect(address: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = netConnect(address)
      socket.once('connect', () => resolve(socket))
      socket.once('error', reject)
    })
  }

  /** 从裸 socket 读够 count 条协议帧（入站面响应与客户端解码器同构）。 */
  function readFrames(socket: Socket, count: number, timeoutMs = 3000): Promise<Json[]> {
    const decoder = createFrameDecoder()
    const received: Json[] = []
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('readFrames 超时')), timeoutMs)
      const onData = (chunk: Buffer): void => {
        try {
          for (const message of decoder.push(chunk)) received.push(message)
        } catch (err) {
          clearTimeout(timer)
          reject(err as Error)
          return
        }
        if (received.length >= count) {
          clearTimeout(timer)
          socket.removeListener('data', onData)
          resolve(received)
        }
      }
      socket.on('data', onData)
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  it('seed fixtures → startHost → status.loaded 恰为实际装载身份', async () => {
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    expect(report.ok).toBe(true)

    await host(async (handle) => {
      const client = await connect({ root, timeoutMs: 3000 })
      try {
        const status = await client.status()
        expect(status.loaded.map((x) => x.id).sort()).toEqual(['toy-alpha', 'toy-beta'])
        // gen 断言直接对世界 active，而非只查长度
        const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
        for (const item of status.loaded) {
          expect(item.gen).toBe(world.ids[item.id].active)
        }
      } finally {
        client.close()
      }
    })
  })

  it('stop() 记 host.start / host.stop，停机后锁可再抢、socket 关闭', async () => {
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    expect(report.ok).toBe(true)
    const lifecycleFile = hostPaths(root).lifecycleFile

    let startAt = 0
    await host(async (handle) => {
      const startEntry = readLifecycle(lifecycleFile).find(
        (e) => e.kind === 'host' && e.event === 'start',
      )
      expect(startEntry).toBeDefined()
      startAt = startEntry!.at
      await handle.stop()
    })

    const stopEntry = readLifecycle(lifecycleFile).find(
      (e) => e.kind === 'host' && e.event === 'stop',
    )
    expect(stopEntry).toBeDefined()
    expect(stopEntry!.at).toBeGreaterThanOrEqual(startAt)

    const lock = acquireLock(hostPaths(root).lockFile, Date.now())
    expect(lock.ok).toBe(true)
    if (lock.ok) releaseLock(hostPaths(root).lockFile)

    await expect(connect({ root, timeoutMs: 1000 })).rejects.toThrow()
  })

  it('服务 event 广播到已连接客户端：断言收到 {kind event, impl, topic, payload}', async () => {
    const eventRoot = writeTempPackage(root, {
      identity: 'toy-event',
      start: 'node execute/main.js',
      implements: ['toy.event'],
      health: { probe: 'toy.event.echo', interval_ms: 100, timeout_ms: 200 },
      serviceConfig: { eventTopic: 'ping', eventPayload: { n: 7 }, eventOnProbe: true },
    })
    const report = runSeed(root, [
      { name: 'toy-event', path: eventRoot },
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
    ])
    expect(report.ok).toBe(true)

    const received: Array<{ impl: string; topic: string; payload: Json }> = []
    await host(async () => {
      const client = await connect({ root, timeoutMs: 3000 })
      client.onEvent((event) => received.push(event))
      try {
        await waitForLifecycle(
          hostPaths(root).lifecycleFile,
          (e) => e.kind === 'host' && e.event === 'start',
          '宿主 start 事件落日志',
        )
        const deadline = Date.now() + 8000
        while (Date.now() < deadline && !received.some((e) => e.impl === 'toy-event')) {
          await new Promise((resolve) => setTimeout(resolve, 25))
        }
        const ev = received.find((e) => e.impl === 'toy-event')
        expect(ev).toBeDefined()
        expect(ev!.topic).toBe('ping')
        expect(ev!.payload).toEqual({ n: 7 })
      } finally {
        client.close()
      }
    })
  }, 15000)

  it('E2E：fixtures + 环 + 握手不符包同处一界，只隔离各自分支，fixtures 仍 loaded', async () => {
    // cyc-b v1（无 pins）→ cyc-a（pins cyc-b）→ cyc-b v2（pins cyc-a）：双世代构成环
    const cycBRoot = writeTempPackage(root, { identity: 'toy-cyc-b' })
    const cycARoot = writeTempPackage(root, {
      identity: 'toy-cyc-a',
      pins: { b: 'toy-cyc-b' },
    })
    const badRoot = writeTempPackage(root, {
      identity: 'toy-bad',
      start: 'node execute/main.js',
      implements: ['toy.bad'],
      serviceConfig: { manifest: { protocol: '9' } },
    })

    const s1 = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-beta', path: FIXTURE_BETA },
    ])
    expect(s1.ok).toBe(true)

    const s2 = runSeed(root, [{ name: 'toy-cyc-b', path: cycBRoot }])
    expect(s2.ok).toBe(true)

    const s3 = runSeed(root, [{ name: 'toy-cyc-a', path: cycARoot }])
    expect(s3.ok).toBe(true)

    // 换代 cyc-b：pins 指向 cyc-a，与 cyc-a 的 pins 形成闭环
    writeTempPackage(root, {
      identity: 'toy-cyc-b',
      pins: { a: 'toy-cyc-a' },
    })
    const s4 = runSeed(root, [{ name: 'toy-cyc-b', path: cycBRoot }])
    const cycB = s4.items.find((i) => i.name === 'toy-cyc-b')
    expect(cycB!.status).toBe('seeded')

    const s5 = runSeed(root, [{ name: 'toy-bad', path: badRoot }])
    expect(s5.ok).toBe(true)

    const lifecycleFile = hostPaths(root).lifecycleFile
    await host(async (handle) => {
      const client = await connect({ root, timeoutMs: 3000 })
      try {
        const status = await client.status()
        expect(status.loaded.map((x) => x.id).sort()).toEqual(['toy-alpha', 'toy-beta'])
      } finally {
        client.close()
      }
      await handle.stop()
    })

    const entries = readLifecycle(lifecycleFile)
    expect(entries).toContainEqual(
      expect.objectContaining({ kind: 'handshake', event: 'failed', impl: 'toy-bad' }),
    )
    expect(
      entries
        .filter((e) => e.kind === 'dep' && e.event === 'cycle')
        .map((e) => e.impl)
        .sort(),
    ).toEqual(['toy-cyc-a', 'toy-cyc-b'])
  }, 15000)

  it('E2E fixture 包自身 .worldignore 生效：物化树不含 test/，含根级 test.js', async () => {
    const report = runSeed(root, [{ name: 'toy-alpha', path: FIXTURE_ALPHA }])
    expect(report.ok).toBe(true)
    const world = loadAnchor(join(root, 'state', 'world', 'journal.jsonl')).world
    const commitHash = world.ids['toy-alpha'].active as string
    const rootDir = materializeCommit(world, commitHash, hostPaths(root).materializedDir, {
      blobsDir: hostPaths(root).blobsDir,
    })
    expect(rootDir).not.toBeNull()
    expect(existsSync(join(rootDir as string, 'test', 'sample.test.js'))).toBe(false)
    expect(existsSync(join(rootDir as string, 'test'))).toBe(false)
    expect(existsSync(join(rootDir as string, 'test.js'))).toBe(true)
  })

  it('O-a：帧长合法但 JSON 非法 → 连接被断开，宿主存活', async () => {
    runSeed(root, [])
    await host(async (handle) => {
      const socket = await rawConnect(handle.socket)
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      const prefix = Buffer.alloc(4)
      prefix.writeUInt32BE(1, 0)
      socket.write(Buffer.concat([prefix, Buffer.from('{', 'utf8')]))
      await closed

      // 宿主进程未因入站损坏退出：普通客户端仍能握手取状态
      const client = await connect({ root, timeoutMs: 3000 })
      try {
        const status = await client.status()
        expect(Array.isArray(status.loaded)).toBe(true)
      } finally {
        client.close()
      }
    })
  })

  it('O-a：submit 缺 directives / 非数组 / 非法 kind → bad_directive，宿主存活', async () => {
    runSeed(root, [])
    await host(async (handle) => {
      const socket = await rawConnect(handle.socket)
      try {
        socket.write(encodeFrame({ v: '1', id: 'm1', kind: 'submit' }))
        socket.write(encodeFrame({ v: '1', id: 'm2', kind: 'submit', directives: {} }))
        socket.write(
          encodeFrame({ v: '1', id: 'm3', kind: 'submit', directives: [{ kind: 'bogus' }] }),
        )
        const responses = await readFrames(socket, 3)
        const byId = new Map(
          responses.map((raw) => {
            const record = raw as { [k: string]: Json }
            return [record['id'] as string, record]
          }),
        )
        for (const id of ['m1', 'm2', 'm3']) {
          const response = byId.get(id)
          expect(response).toBeDefined()
          expect(response!['kind']).toBe('error')
          expect(response!['code']).toBe('bad_directive')
        }
      } finally {
        socket.destroy()
      }

      const client = await connect({ root, timeoutMs: 3000 })
      try {
        const status = await client.status()
        expect(Array.isArray(status.loaded)).toBe(true)
      } finally {
        client.close()
      }
    })
  })

  // POSIX 下 startHost 会先 unlink 陈旧 socket 文件再 listen，占用文件会被清掉而 listen 成功；
  // Windows named pipe 无 unlink 语义，占用同名管道即稳定触发 EADDRINUSE。
  it.runIf(process.platform === 'win32')(
    'O-a：listen 失败（socket 被占用）→ startHost 抛错，锁可再抢、无遗留服务进程',
    async () => {
      const pidFile = join(root, 'svc.pid')
      const pkgRoot = writeTempPackage(root, {
        identity: 'toy-pid',
        start: 'node execute/main.js',
        implements: ['toy.pid'],
        files: {
          'execute/main.js': `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))\n${FIXTURE_SERVICE_MAIN}`,
        },
      })
      const report = runSeed(root, [{ name: 'toy-pid', path: pkgRoot }])
      expect(report.ok).toBe(true)

      const blocker = createServer()
      const address = socketPath(root)
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(address, () => resolve())
      })
      try {
        await expect(startHost({ root })).rejects.toThrow()
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }

      // 服务进程已随失败清理退出，无遗留
      const pid = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
      expect(Number.isInteger(pid)).toBe(true)
      await waitFor(() => !isPidAlive(pid), `启动失败后服务进程退出 pid=${pid}`, 5000)

      // 锁已释放，可再抢
      const lock = acquireLock(hostPaths(root).lockFile, Date.now())
      expect(lock.ok).toBe(true)
      if (lock.ok) releaseLock(hostPaths(root).lockFile)
    },
    15000,
  )
})
