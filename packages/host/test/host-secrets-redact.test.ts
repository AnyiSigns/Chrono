// H7 效果审计脱敏：port=secrets + method=resolve 的审计 result 只落 {name, kind, has}，
// 明文（短时句柄）不进审计正文；调用方仍拿真实值。审计写旁路侧存（不进世界 / journal）。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { createTempRoot, cleanupTempRoot, readAuditRecords } from './test-helpers.ts'
import { writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import { hostPaths } from '../paths.ts'
import type { Json } from '../../kernel/index.ts'

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

  /** 侧存里 port=secrets 的审计正文。 */
  function secretsAuditBody(): { result: Json; outcome: string } {
    const record = readAuditRecords(root).find(
      (item) => (item.body as { port?: string }).port === 'secrets',
    )
    expect(record).toBeDefined()
    return (record as { body: { result: Json; outcome: string } }).body
  }

  it('成功：审计 result = {name, kind, has:true}，不含明文；调用方仍拿真实句柄', async () => {
    seedSecrets({ token: SECRET })
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
    // 明文不进任何落盘面：journal 与审计侧存都不含
    expect(readFileSync(hostPaths(root).journalFile, 'utf8')).not.toContain(SECRET)
    expect(readFileSync(hostPaths(root).auditFile, 'utf8')).not.toContain(SECRET)
    const body = secretsAuditBody()
    expect(body.result).toEqual({ name: 'API_KEY', kind: 'local', has: true })
    expect(body.outcome).toBe('ok')
  })

  it('服务回 error：审计 result 记 {name, kind, has:false}', async () => {
    seedSecrets(undefined, 'error')
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-caller.resolve')
      expect(result.status).toBe('done')
    } finally {
      client.close()
    }
    const body = secretsAuditBody()
    expect(body.result).toEqual({ name: 'API_KEY', kind: 'local', has: false })
    expect(body.outcome).toBe('error')
  })
})
