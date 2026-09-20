// H7 效果审计脱敏：port=secrets + method=resolve 的审计 result 只落 {name, kind, has}，
// 明文（短时句柄）不进审计正文；调用方仍拿真实值。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { Entry, Json } from '../../kernel/index.ts'

const SECRET = 'SECRET-PLAINTEXT-TOKEN'

const RESOLVE_TERM: Json = [
  'eff',
  'secrets',
  'resolve',
  ['c', { auth_ref: { kind: 'local', name: 'API_KEY' } }],
]

describe('H7 效果审计脱敏（secrets.resolve）', () => {
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

  function seedSecrets(callValue: Json | undefined, callMode?: string): void {
    const impl = writeTempPackage(root, {
      identity: 'secrets-impl',
      implements: ['secrets'],
      methods: { secrets: ['resolve'] },
      start: 'node execute/main.js',
      serviceConfig:
        callMode === undefined ? { callValue } : { callMode, callErrorCode: 'secret_missing' },
    })
    const caller = writeTempPackage(root, {
      identity: 'toy-secrets-caller',
      pins: { secrets: 'secrets-impl' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'resolve.json': JSON.stringify(RESOLVE_TERM) },
      commands: [{ name: 'toy-caller.resolve', entry: 'terms/resolve.json' }],
    })
    expect(
      runSeed(root, [
        { name: 'secrets-impl', path: impl },
        { name: 'toy-secrets-caller', path: caller },
      ]).ok,
    ).toBe(true)
  }

  function auditEntryOf(entries: Entry[]): { body: { result: Json; outcome: string } } {
    const audit = entries.find(
      (entry) => (entry.args as { body?: { port?: string } }).body?.port === 'secrets',
    )
    expect(audit).toBeDefined()
    return audit!.args as unknown as { body: { result: Json; outcome: string } }
  }

  it('成功：审计 result = {name, kind, has:true}，不含明文；调用方仍拿真实句柄', async () => {
    seedSecrets({ token: SECRET })
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.resolve')
      expect(result.status).toBe('done')
      // 调用方拿到真实值（回灌不变）
      expect((result.observations[0] as { value: Json }).value).toEqual({ token: SECRET })
    } finally {
      client.close()
    }
    const added = readJournal(journalFile()).slice(before)
    expect(JSON.stringify(added)).not.toContain(SECRET)
    const body = auditEntryOf(added).body
    expect(body.result).toEqual({ name: 'API_KEY', kind: 'local', has: true })
    expect(body.outcome).toBe('ok')
  })

  it('服务回 error：审计 result 记 {name, kind, has:false}', async () => {
    seedSecrets(undefined, 'error')
    const before = readJournal(journalFile()).length
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.resolve')
      expect(result.status).toBe('done')
    } finally {
      client.close()
    }
    const added = readJournal(journalFile()).slice(before)
    const body = auditEntryOf(added).body
    expect(body.result).toEqual({ name: 'API_KEY', kind: 'local', has: false })
    expect(body.outcome).toBe('error')
  })
})
