// H7 密钥本地存储面：入站 put/delete 直写本地文件，不经 run、不进世界、不进审计。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { connect as netConnect } from 'node:net'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { hostPaths, socketPath } from '../paths.ts'
import { readJournal } from '../ledger/index.ts'
import { MAX_SECRET_VALUE_BYTES, deleteSecret, putSecret, readSecrets } from '../secrets.ts'
import { createFrameDecoder, encodeFrame } from '../wire.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { connect } from '../../client/index.ts'
import type { Json } from '../../kernel/index.ts'

/** 直接走入站面发一条消息并取回首帧（secrets 动词无客户端库方法，用裸 socket 更贴近协议）。 */
function rawRequest(root: string, message: Json): Promise<Json> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(socketPath(root))
    const decoder = createFrameDecoder()
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('raw request timeout'))
    }, 3000)
    socket.on('connect', () => socket.write(encodeFrame(message)))
    socket.on('data', (chunk) => {
      const frames = decoder.push(chunk)
      if (frames.length === 0) return
      clearTimeout(timer)
      socket.destroy()
      resolve(frames[0])
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

describe('H7 密钥本地存储面', () => {
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

  it('put/delete/read：JSON 文件往返，删除保留其余项、删缺失项无副作用', () => {
    const file = hostPaths(root).secretsFile
    expect(putSecret(file, 'A', 'one')).toEqual({ ok: true })
    expect(putSecret(file, 'B', 'two')).toEqual({ ok: true })
    expect(readSecrets(file)).toEqual({ ok: true, secrets: { A: 'one', B: 'two' } })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ A: 'one', B: 'two' })
    expect(deleteSecret(file, 'A')).toEqual({ ok: true })
    expect(readSecrets(file)).toEqual({ ok: true, secrets: { B: 'two' } })
    expect(deleteSecret(file, 'missing')).toEqual({ ok: true })
    expect(readSecrets(file)).toEqual({ ok: true, secrets: { B: 'two' } })
  })

  it('文件缺失 → 空表；解析失败 / 非对象 → 损坏（区分两种状态）', () => {
    const file = hostPaths(root).secretsFile
    expect(readSecrets(file)).toEqual({ ok: true, secrets: {} })
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ not json')
    expect(readSecrets(file)).toEqual({ ok: false, reason: 'corrupt' })
    writeFileSync(file, '[1, 2]')
    expect(readSecrets(file)).toEqual({ ok: false, reason: 'corrupt' })
  })

  it('损坏文件 fail-closed：put/delete 返回错误且不覆写文件', () => {
    const file = hostPaths(root).secretsFile
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{ not json')
    const before = readFileSync(file, 'utf8')
    expect(putSecret(file, 'A', 'one')).toEqual({ ok: false, reason: 'corrupt' })
    expect(deleteSecret(file, 'A')).toEqual({ ok: false, reason: 'corrupt' })
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('保留键 / 空名 / 超长值被拒，不落文件', () => {
    const file = hostPaths(root).secretsFile
    for (const name of ['__proto__', 'constructor', 'prototype', '']) {
      expect(putSecret(file, name, 'x')).toEqual({ ok: false, reason: 'bad_name' })
      expect(deleteSecret(file, name)).toEqual({ ok: false, reason: 'bad_name' })
    }
    expect(putSecret(file, 'K', 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1))).toEqual({
      ok: false,
      reason: 'too_large',
    })
    expect(existsSync(file)).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('落盘权限为 0600（POSIX）', () => {
    const file = hostPaths(root).secretsFile
    expect(putSecret(file, 'A', 'one')).toEqual({ ok: true })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('入站 put/delete：落本地文件、不进世界 / 不进审计 / 不推进 head', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const before = (await client.status()).world_head
      const journalBefore = readJournal(journalFile()).length
      const put = await rawRequest(root, {
        v: '1',
        id: 's1',
        kind: 'secrets.put',
        name: 'API_KEY',
        value: 'plain-secret',
      })
      expect(put).toMatchObject({ kind: 'secrets.ok', name: 'API_KEY' })
      const file = hostPaths(root).secretsFile
      expect(readSecrets(file)).toEqual({ ok: true, secrets: { API_KEY: 'plain-secret' } })
      expect((await client.status()).world_head).toEqual(before)
      expect(readJournal(journalFile()).length).toBe(journalBefore)

      const del = await rawRequest(root, {
        v: '1',
        id: 's2',
        kind: 'secrets.delete',
        name: 'API_KEY',
      })
      expect(del).toMatchObject({ kind: 'secrets.ok', name: 'API_KEY' })
      expect(readSecrets(file)).toEqual({ ok: true, secrets: {} })
      expect((await client.status()).world_head).toEqual(before)
      expect(readJournal(journalFile()).length).toBe(journalBefore)
    } finally {
      client.close()
    }
  })

  it('非法 name / value → bad_directive，不落文件', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const file = hostPaths(root).secretsFile
    const emptyName = await rawRequest(root, {
      v: '1',
      id: 'b1',
      kind: 'secrets.put',
      name: '',
      value: 'x',
    })
    expect(emptyName).toMatchObject({ kind: 'error', code: 'bad_directive' })
    const badValue = await rawRequest(root, {
      v: '1',
      id: 'b2',
      kind: 'secrets.put',
      name: 'K',
      value: 5,
    })
    expect(badValue).toMatchObject({ kind: 'error', code: 'bad_directive' })
    const badDelete = await rawRequest(root, {
      v: '1',
      id: 'b3',
      kind: 'secrets.delete',
      name: '',
    })
    expect(badDelete).toMatchObject({ kind: 'error', code: 'bad_directive' })
    const proto = await rawRequest(root, {
      v: '1',
      id: 'b4',
      kind: 'secrets.put',
      name: '__proto__',
      value: 'x',
    })
    expect(proto).toMatchObject({ kind: 'error', code: 'bad_directive' })
    const tooLong = await rawRequest(root, {
      v: '1',
      id: 'b5',
      kind: 'secrets.put',
      name: 'K',
      value: 'x'.repeat(MAX_SECRET_VALUE_BYTES + 1),
    })
    expect(tooLong).toMatchObject({ kind: 'error', code: 'bad_directive' })
    expect(existsSync(file)).toBe(false)
  })

  it('损坏文件：入站 put 返回错误且不覆写', async () => {
    const handle = await startHost({ root })
    handles.push(handle)
    const file = hostPaths(root).secretsFile
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, '{bad')
    const result = await rawRequest(root, {
      v: '1',
      id: 'c1',
      kind: 'secrets.put',
      name: 'K',
      value: 'v',
    })
    expect(result).toMatchObject({ kind: 'error', code: 'internal' })
    expect(readFileSync(file, 'utf8')).toBe('{bad')
  })
})
