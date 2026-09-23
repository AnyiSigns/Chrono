// H10 宿主 run 生命周期事件：run.started / run.finished 经入站广播（impl=host，不落账、不推进），
// 载荷带 run / thread / status / reasons；submit 的 thread 原样回带，缺省为 null。

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { connect as netConnect } from 'node:net'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { hostPaths, socketPath } from '../paths.ts'
import { createFrameDecoder, encodeFrame } from '../wire.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { readLifecycle, waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

/** 注入失败入口：`runSubmission` 见到该 entry 即抛错（H10 异常路径成对测试）。 */
const THROW_ENTRY = 'e'.repeat(64)

vi.mock('../effect/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../effect/index.ts')>()
  return {
    ...actual,
    runSubmission: (input: Parameters<typeof actual.runSubmission>[0]) =>
      input.directives.some(
        (directive) =>
          directive.kind === 'eval' && 'entry' in directive && directive.entry === 'e'.repeat(64),
      )
        ? Promise.reject(new Error('injected run failure'))
        : actual.runSubmission(input),
  }
})

/** 裸 socket 发一条消息，收集帧直到 predicate 为真（或超时）。 */
function rawCollect(
  root: string,
  message: Json,
  done: (frames: Json[]) => boolean,
  timeoutMs = 4000,
): Promise<Json[]> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath(root))
    const decoder = createFrameDecoder()
    const frames: Json[] = []
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(frames)
    }, timeoutMs)
    socket.on('connect', () => socket.write(encodeFrame(message)))
    socket.on('data', (chunk) => {
      frames.push(...decoder.push(chunk))
      if (done(frames)) {
        clearTimeout(timer)
        socket.destroy()
        resolve(frames)
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function isRecord(value: Json | undefined): value is { [k: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

describe('H10 宿主 run 生命周期事件', () => {
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
        // 兜底停机
      }
    }
    handles.length = 0
    await cleanupTempRoot(root)
  })

  function seedCommand(): void {
    const pkg = writeTempPackage(root, {
      identity: 'toy-run',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'hello.json': JSON.stringify(['c', 1]) },
      commands: [{ name: 'toy-run.hello', entry: 'terms/hello.json' }],
    })
    expect(runSeed(root, [{ name: 'toy-run', path: pkg }]).ok).toBe(true)
  }

  it('submit（带 thread）：run.started / run.finished 各一次，载荷带 run/thread/status', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const frames = await rawCollect(
      root,
      {
        v: '1',
        id: 'evt-1',
        kind: 'submit',
        thread: 'thread-1',
        directives: [{ kind: 'extern', payload: { x: 1 } }],
      },
      (all) => all.some((frame) => isRecord(frame) && frame['kind'] === 'result' && 'run' in frame),
    )
    const events = frames.filter(isRecord).filter((frame) => frame['kind'] === 'event')
    const started = events.filter((event) => event['topic'] === 'run.started')
    const finished = events.filter((event) => event['topic'] === 'run.finished')
    expect(started).toHaveLength(1)
    expect(finished).toHaveLength(1)
    const startedPayload = started[0]['payload'] as { [k: string]: Json }
    const run = startedPayload['run']
    expect(typeof run).toBe('string')
    expect(started[0]).toMatchObject({ impl: 'host' })
    expect(startedPayload['thread']).toBe('thread-1')
    expect(startedPayload['origin']).toBe('submit')
    expect(finished[0]).toMatchObject({ impl: 'host' })
    expect(finished[0]['payload']).toMatchObject({
      run,
      thread: 'thread-1',
      status: 'done',
      reasons: [],
      origin: 'submit',
    })
  })

  it('submit 异常路径：run.started / run.finished 成对且各一次，status=refused + 运维日志', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const frames = await rawCollect(
      root,
      {
        v: '1',
        id: 'evt-err',
        kind: 'submit',
        thread: 'thread-err',
        directives: [{ kind: 'eval', entry: THROW_ENTRY, args: null }],
      },
      (all) =>
        all.some(
          (frame) =>
            isRecord(frame) && frame['kind'] === 'event' && frame['topic'] === 'run.finished',
        ),
    )
    const events = frames.filter(isRecord).filter((frame) => frame['kind'] === 'event')
    const started = events.filter((event) => event['topic'] === 'run.started')
    const finished = events.filter((event) => event['topic'] === 'run.finished')
    expect(started).toHaveLength(1)
    expect(finished).toHaveLength(1)
    const run = (started[0]['payload'] as { run: string }).run
    expect(finished[0]['payload']).toMatchObject({
      run,
      thread: 'thread-err',
      status: 'refused',
      reasons: [],
    })
    const failed = readLifecycle(hostPaths(root).lifecycleFile).filter(
      (entry) => entry.event === 'run_failed',
    )
    expect(failed).toHaveLength(1)
    expect(failed[0].reason).toContain('injected run failure')
  })

  it('refused 收口：run.finished 的 reasons 取自 observations 末条 refused', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const frames = await rawCollect(
      root,
      {
        v: '1',
        id: 'evt-reasons',
        kind: 'submit',
        thread: 'thread-reasons',
        directives: [
          {
            kind: 'write',
            request: { id: 'w-1', op: 'put', args: { pins: { x: 'missing-identity' } }, by: 'c' },
          },
        ],
      },
      (all) =>
        all.some(
          (frame) =>
            isRecord(frame) && frame['kind'] === 'event' && frame['topic'] === 'run.finished',
        ),
    )
    const finished = frames
      .filter(isRecord)
      .filter((frame) => frame['kind'] === 'event' && frame['topic'] === 'run.finished')
    expect(finished).toHaveLength(1)
    expect(finished[0]['payload']).toMatchObject({
      thread: 'thread-reasons',
      status: 'refused',
      reasons: ['unresolved_pin'],
    })
  })

  it('command run 也发事件，thread 缺省 null、status 正确', async () => {
    seedCommand()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const result = await client.command('toy-run.hello')
      expect(result.status).toBe('done')
      await waitFor(
        () => events.some((event) => event.impl === 'host' && event.topic === 'run.finished'),
        'command run.finished',
      )
      const started = events.filter(
        (event) => event.impl === 'host' && event.topic === 'run.started',
      )
      const finished = events.filter(
        (event) => event.impl === 'host' && event.topic === 'run.finished',
      )
      expect(started).toHaveLength(1)
      expect(finished).toHaveLength(1)
      const run = (started[0].payload as { run: string }).run
      expect((started[0].payload as { origin?: string }).origin).toBe('command')
      expect(isRecord(finished[0].payload)).toBe(true)
      expect(finished[0].payload).toMatchObject({
        run,
        thread: null,
        status: 'done',
        reasons: [],
        origin: 'command',
      })
    } finally {
      client.close()
    }
  })
})
