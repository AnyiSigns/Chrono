// H8 插件入站转发：壳把 `/p/<id>/*` 转成宿主入站帧，宿主按 `identity` 只转发到该身份
// 自己声明的入口 term（构造一次 run）；命令不属于该身份即拒。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

const PING_TERM: Json = [
  'c',
  { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { forwarded: true } } } }] },
]

describe('H8 插件入站转发', () => {
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

  function seedForward(): void {
    const pkg = writeTempPackage(root, {
      identity: 'toy-fwd',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'ping.json': JSON.stringify(PING_TERM) },
      commands: [{ name: 'toy-fwd.ping', entry: 'terms/ping.json' }],
    })
    const other = writeTempPackage(root, {
      identity: 'toy-fwd2',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'ping.json': JSON.stringify(PING_TERM) },
      commands: [{ name: 'toy-fwd2.ping', entry: 'terms/ping.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'toy-fwd', path: pkg },
        { name: 'toy-fwd2', path: other },
      ]).ok,
    ).toBe(true)
  }

  it('forward：按身份转发到自身声明入口（起 run + 生命周期事件）', async () => {
    seedForward()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const before = readJournal(join(root, 'state', 'world', 'journal.jsonl')).length
      const result = await client.forward('toy-fwd', 'toy-fwd.ping', { from: 'mcp' })
      expect(result.status).toBe('done')
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.impl === 'host' &&
              event.topic === 'run.finished' &&
              (event.payload as { thread?: string | null }).thread === null,
          ),
        'forward run.finished',
      )
      expect(readJournal(join(root, 'state', 'world', 'journal.jsonl')).length).toBeGreaterThan(
        before,
      )
    } finally {
      client.close()
    }
  })

  it('forward：命令不属于目标身份 / 未知命令 → unknown_command', async () => {
    seedForward()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      await expect(client.forward('ghost', 'toy-fwd.ping')).rejects.toMatchObject({
        code: 'unknown_command',
      })
      await expect(client.forward('toy-fwd', 'toy-fwd.absent')).rejects.toMatchObject({
        code: 'unknown_command',
      })
      // 命令真实存在、但属主是另一个身份：同样拒（身份约束，不是名字存在性）
      await expect(client.forward('toy-fwd', 'toy-fwd2.ping')).rejects.toMatchObject({
        code: 'unknown_command',
      })
    } finally {
      client.close()
    }
  })
})
