// H14 宿主保留能力类 host：audit / asset.put / asset.get / source.read /
// thread.terminate / thread.resume 经 eff 路由到宿主自身，结果作数据回灌。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { MAX_DETACHED_RUNS, startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal, loadAnchor } from '../ledger/index.ts'
import { resolveTreeEntry } from '../assembly/index.ts'
import { isBlobPointer } from '../blobs.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { FIXTURE_ALPHA, waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

const ECHO_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]
const AUDIT_TERM: Json = ['eff', 'host', 'audit', ['c', { limit: 5 }]]
const IDENTITIES_TERM: Json = ['eff', 'host', 'identities', ['c', null]]
const ASSET_PUT_TERM: Json = ['eff', 'host', 'asset.put', ['v', 0]]
const ASSET_GET_TERM: Json = ['eff', 'host', 'asset.get', ['v', 0]]
const BLOB_PUT_TERM: Json = ['eff', 'host', 'blob.put', ['v', 0]]
const SOURCE_READ_TERM: Json = ['eff', 'host', 'source.read', ['v', 0]]
const VALIDATE_TERM: Json = ['eff', 'host', 'validate_package', ['v', 0]]
const TERMINATE_TERM: Json = ['eff', 'host', 'thread.terminate', ['v', 0]]
const RESUME_TERM: Json = ['eff', 'host', 'thread.resume', ['v', 0]]
const WRITE_TERM: Json = [
  'c',
  { $directives: [{ kind: 'write', request: { op: 'put', args: { body: { resumed: true } } } }] },
]
/** 慢效果入口：detached run 会停在服务调用上，用于占满并发槽位。 */
const SLOW_TERM: Json = ['eff', 'toy.slow', 'echo', ['c', { n: 1 }]]

describe('H14 宿主保留能力类 host', () => {
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

  function journalFile(): string {
    return join(root, 'state', 'world', 'journal.jsonl')
  }

  function seedHost(): void {
    const pkg = writeTempPackage(root, {
      identity: 'toy-host',
      pins: { host: 'host', 'toy.alpha': 'toy-alpha' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: {
        'echo.json': JSON.stringify(ECHO_TERM),
        'audit.json': JSON.stringify(AUDIT_TERM),
        'identities.json': JSON.stringify(IDENTITIES_TERM),
        'assetPut.json': JSON.stringify(ASSET_PUT_TERM),
        'assetGet.json': JSON.stringify(ASSET_GET_TERM),
        'blobPut.json': JSON.stringify(BLOB_PUT_TERM),
        'sourceRead.json': JSON.stringify(SOURCE_READ_TERM),
        'validate.json': JSON.stringify(VALIDATE_TERM),
        'terminate.json': JSON.stringify(TERMINATE_TERM),
        'resume.json': JSON.stringify(RESUME_TERM),
        'write.json': JSON.stringify(WRITE_TERM),
      },
      commands: [
        { name: 'toy-host.echo', entry: 'terms/echo.json' },
        { name: 'toy-host.audit', entry: 'terms/audit.json' },
        { name: 'toy-host.identities', entry: 'terms/identities.json' },
        { name: 'toy-host.assetPut', entry: 'terms/assetPut.json' },
        { name: 'toy-host.assetGet', entry: 'terms/assetGet.json' },
        { name: 'toy-host.blobPut', entry: 'terms/blobPut.json' },
        { name: 'toy-host.sourceRead', entry: 'terms/sourceRead.json' },
        { name: 'toy-host.validate', entry: 'terms/validate.json' },
        { name: 'toy-host.terminate', entry: 'terms/terminate.json' },
        { name: 'toy-host.resume', entry: 'terms/resume.json' },
        { name: 'toy-host.write', entry: 'terms/write.json' },
      ],
    })
    const report = runSeed(root, [
      { name: 'toy-alpha', path: FIXTURE_ALPHA },
      { name: 'toy-host', path: pkg },
    ])
    expect(report.ok).toBe(true)
  }

  function valueOf(result: { observations: Json[] }): Json {
    return (result.observations[0] as { value: Json }).value
  }

  /** toy-host + 一个慢服务（callDelayMs），用于把 detached run 压在在途状态。 */
  function seedSlowHost(): void {
    const slow = writeTempPackage(root, {
      identity: 'toy-slow',
      implements: ['toy.slow'],
      start: 'node execute/main.js',
      serviceConfig: { callDelayMs: 2000 },
    })
    const pkg = writeTempPackage(root, {
      identity: 'toy-host',
      pins: { host: 'host', 'toy.slow': 'toy-slow' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: {
        'resume.json': JSON.stringify(RESUME_TERM),
        'slow.json': JSON.stringify(SLOW_TERM),
      },
      commands: [
        { name: 'toy-host.resume', entry: 'terms/resume.json' },
        { name: 'toy-host.slow', entry: 'terms/slow.json' },
      ],
    })
    expect(
      runSeed(root, [
        { name: 'toy-slow', path: slow },
        { name: 'toy-host', path: pkg },
      ]).ok,
    ).toBe(true)
  }

  it('audit：宿主只读审计面按 filter/limit 返回 {records, truncated}', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-host.echo')).status).toBe('done')
      const value = valueOf(await client.command('toy-host.audit', { limit: 5 })) as {
        records: Array<{ body: { port: string } }>
        truncated: boolean
      }
      expect(value.truncated).toBe(false)
      expect(Array.isArray(value.records)).toBe(true)
      expect(value.records.some((record) => record.body.port === 'toy.alpha')).toBe(true)
    } finally {
      client.close()
    }
  })

  it('identities：机械列出各身份 id / active / implements / commands（不含 pins 明细）', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const value = valueOf(await client.command('toy-host.identities')) as {
        list: Array<{ id: string; active: string | null; implements: string[]; commands: string[] }>
      }
      expect(Array.isArray(value.list)).toBe(true)
      const alpha = value.list.find((entry) => entry.id === 'toy-alpha')
      expect(alpha).toBeDefined()
      expect(alpha?.active).toMatch(/^[0-9a-f]{64}$/)
      expect(alpha?.implements).toEqual(['toy.alpha'])
      const host = value.list.find((entry) => entry.id === 'toy-host')
      expect(host?.commands).toContain('toy-host.identities')
      // 只读清单面不含 pins 明细（pins 在投影 `ids.<id>.pins`）
      expect(host === undefined ? null : Object.hasOwn(host, 'pins')).toBe(false)
    } finally {
      client.close()
    }
  })

  it('asset.put / asset.get：往返一致；缺失 → asset_missing（作数据回灌）', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const payload = Buffer.from('hello host asset')
      const ref = valueOf(
        await client.command('toy-host.assetPut', {
          mime: 'text/plain',
          bytes: payload.toString('base64'),
        }),
      ) as { kind: string; sha256: string; mime: string; size: number }
      expect(ref).toMatchObject({ kind: 'asset', mime: 'text/plain', size: payload.length })
      const got = valueOf(await client.command('toy-host.assetGet', { sha256: ref.sha256 })) as {
        bytes: string
        mime: string
        size: number
      }
      expect(got.mime).toBe('text/plain')
      expect(got.size).toBe(payload.length)
      expect(Buffer.from(got.bytes, 'base64').equals(payload)).toBe(true)

      const missing = valueOf(
        await client.command('toy-host.assetGet', { sha256: '0'.repeat(64) }),
      ) as { error: string }
      expect(missing.error).toBe('asset_missing')
    } finally {
      client.close()
    }
  })

  it('blob.put：源码字节内容寻址落 CAS，回 pointer def body；非法 base64 → bad_blob', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const payload = Buffer.from('hello source blob')
      const pointer = valueOf(
        await client.command('toy-host.blobPut', { bytes: payload.toString('base64') }),
      ) as { kind: string; sha256: string; size: number }
      expect(pointer).toMatchObject({ kind: 'blob', size: payload.length })
      expect(pointer.sha256).toMatch(/^[0-9a-f]{64}$/)
      // 字节本体落 state/blobs/<sha256>，与 pointer.sha256 对应
      const file = join(root, 'state', 'blobs', pointer.sha256)
      expect(existsSync(file)).toBe(true)
      expect(readFileSync(file).equals(payload)).toBe(true)

      const bad = valueOf(await client.command('toy-host.blobPut', { bytes: 'not base64!' })) as {
        error: string
      }
      expect(bad.error).toBe('bad_blob')
    } finally {
      client.close()
    }
  })

  it('source.read：读回源码 blob（base64）；目录 / 不存在 → not_found', async () => {
    seedHost()
    // 入世已是 pointer 形态：源码读面必须经 CAS 解析
    const world = loadAnchor(journalFile()).world
    const commitHash = world.ids['toy-host'].active as string
    const tree = (world.defs[commitHash].body as { tree: string }).tree
    const entry = resolveTreeEntry(world, tree, 'plugin.json')
    expect(entry).not.toBeNull()
    expect(isBlobPointer(world.defs[entry!.hash].body)).toBe(true)

    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const value = valueOf(
        await client.command('toy-host.sourceRead', {
          identity: 'toy-host',
          path: 'plugin.json',
        }),
      ) as { path: string; content: string; size: number }
      expect(value.path).toBe('plugin.json')
      const text = Buffer.from(value.content, 'base64').toString('utf8')
      expect((JSON.parse(text) as { identity: string }).identity).toBe('toy-host')
      expect(value.size).toBe(Buffer.byteLength(text, 'utf8'))

      const dir = valueOf(
        await client.command('toy-host.sourceRead', { identity: 'toy-host', path: 'terms' }),
      ) as { error: string }
      expect(dir.error).toBe('not_found')
      const absent = valueOf(
        await client.command('toy-host.sourceRead', {
          identity: 'ghost',
          path: 'plugin.json',
        }),
      ) as { error: string }
      expect(absent.error).toBe('not_found')
    } finally {
      client.close()
    }
  })

  it('validate_package：dry-run 候选包（通过回 result_hash / 缺件回 errors / 逃逸路径拒）', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const candidate = {
        'plugin.json': JSON.stringify({
          identity: 'candidate',
          schema: 'schema/plugin.schema.json',
          implements: [],
          methods: {},
          pins: {},
          start: '',
          protocol: '1',
          restart: { policy: 'never', backoff: 'none', max: 0, window_ms: 1, drain_ms: 1 },
          health: { probe: '', interval_ms: 0, timeout_ms: 0 },
          state: 'recomputable',
          members: [],
          commands: [],
        }),
        'schema/plugin.schema.json': JSON.stringify({ type: 'object' }),
        'package.json': JSON.stringify({ name: 'candidate', version: '1.2.3' }),
      }
      const valid = valueOf(await client.command('toy-host.validate', { files: candidate })) as {
        ok: boolean
        errors: unknown[]
        result_hash: string | null
      }
      expect(valid.ok).toBe(true)
      expect(valid.errors).toEqual([])
      expect(valid.result_hash).toMatch(/^[0-9a-f]{64}$/)

      const missing = valueOf(
        await client.command('toy-host.validate', {
          files: { 'schema/plugin.schema.json': '{}' },
        }),
      ) as { ok: boolean; errors: { code: string }[] }
      expect(missing.ok).toBe(false)
      expect(missing.errors[0].code).toBe('missing_plugin_json')

      const unsafe = valueOf(
        await client.command('toy-host.validate', { files: { '../escape': 'x' } }),
      ) as { error: string }
      expect(unsafe.error).toBe('bad_directive')
    } finally {
      client.close()
    }
  })

  it('thread.terminate：未知 run → unknown_run', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const value = valueOf(await client.command('toy-host.terminate', { run: 'not-a-run' })) as {
        error: string
      }
      expect(value.error).toBe('unknown_run')
    } finally {
      client.close()
    }
  })

  it('thread.resume：启动 detached run（事件广播 + 世界推进），立即回 run id', async () => {
    seedHost()
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const commands = await client.commands()
      const entry = commands.find((command) => command.name === 'toy-host.write')?.entry
      expect(entry).toBeDefined()
      const before = readJournal(journalFile()).length
      const value = valueOf(
        await client.command('toy-host.resume', { entry: entry as string, args: null }),
      ) as { run: string }
      expect(typeof value.run).toBe('string')
      // detached run 照常落账（世界推进）并广播起止事件
      await waitFor(() => readJournal(journalFile()).length > before, 'detached run write')
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.impl === 'host' &&
              event.topic === 'run.finished' &&
              (event.payload as { run?: string }).run === value.run,
          ),
        'detached run.finished',
      )
      const detachedStart = events.find(
        (event) =>
          event.impl === 'host' &&
          event.topic === 'run.started' &&
          (event.payload as { run?: string }).run === value.run,
      )
      expect(detachedStart).toBeDefined()
      expect((detachedStart?.payload as { origin?: string }).origin).toBe('detached')
    } finally {
      client.close()
    }
  })

  it('thread.resume：thread 透传到事件；并发超上限 → too_many_runs', async () => {
    seedSlowHost()
    const handle = await startHost({ root, callTimeoutMs: 10_000 })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 10_000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      const commands = await client.commands()
      const entry = commands.find((command) => command.name === 'toy-host.slow')?.entry
      expect(entry).toBeDefined()

      // thread 透传：resume 参数里的 thread 原样出现在 detached run.started 事件
      const tagged = valueOf(
        await client.command('toy-host.resume', {
          entry: entry as string,
          args: null,
          thread: 'thr-1',
        }),
      ) as { run: string }
      await waitFor(
        () =>
          events.some(
            (event) =>
              event.topic === 'run.started' &&
              (event.payload as { run?: string }).run === tagged.run,
          ),
        'tagged run.started',
      )
      const taggedStart = events.find(
        (event) =>
          event.topic === 'run.started' && (event.payload as { run?: string }).run === tagged.run,
      )
      expect((taggedStart!.payload as { thread?: string }).thread).toBe('thr-1')

      // 占满剩余槽位（慢效果使它们停在在途）
      for (let i = 1; i < MAX_DETACHED_RUNS; i++) {
        const value = valueOf(
          await client.command('toy-host.resume', { entry: entry as string, args: null }),
        ) as { run?: string }
        expect(typeof value.run).toBe('string')
      }
      const overflow = valueOf(
        await client.command('toy-host.resume', { entry: entry as string, args: null }),
      ) as { error: string }
      expect(overflow.error).toBe('too_many_runs')
    } finally {
      client.close()
    }
  }, 30000)
})
