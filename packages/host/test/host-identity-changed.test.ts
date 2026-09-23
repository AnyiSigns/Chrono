// 通知面语义化：世界推进后按身份 diff 广播 host.identity.changed——
// 代码世代 active 变（含新增 / 退役）→ code；否则数据世代 payload 变 → data；无变化不发。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { loadAnchor } from '../ledger/index.ts'
import { H } from '../../kernel/index.ts'
import type { Directive, Hash, Json } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot, createToyPlugin } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { EventMessage } from '../../client/index.ts'

interface IdentityChanged {
  identity: string
  kind: 'code' | 'data'
  active: Hash | null
  prev: Hash | null
}

describe('host.identity.changed 通知面', () => {
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

  function writeDirective(op: 'put' | 'batch', args: Json): Directive {
    return {
      kind: 'write',
      request: { id: `w-${randomUUID()}`, op, target: { expect_pos: null }, args, by: 'client' },
    }
  }

  function identityEvents(events: EventMessage[]): IdentityChanged[] {
    return events
      .filter((event) => event.impl === 'host' && event.topic === 'identity.changed')
      .map((event) => event.payload as unknown as IdentityChanged)
  }

  it('无变化不发；数据世代 → data；代码世代 → code', async () => {
    createToyPlugin(root)
    const reader = writeTempPackage(root, {
      identity: 'toy-reader',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-reader.body', entry: 'terms/body.json' }],
      terms: { 'body.json': JSON.stringify(['g', ['ids', 'toy', 'body']]) },
    })
    expect(
      runSeed(root, [
        { name: 'toy', path: join(root, 'pkg', 'toy') },
        { name: 'toy-reader', path: reader },
      ]).ok,
    ).toBe(true)
    const anchor = loadAnchor(journalFile())
    const codeGen1 = anchor.world.ids['toy'].active as Hash
    const tree = (anchor.world.defs[codeGen1].body as { tree: Hash }).tree

    const handle = await startHost({ root })
    handles.push(handle)
    const client = await connect({ root, timeoutMs: 3000 })
    const events: EventMessage[] = []
    client.onEvent((event) => events.push(event))
    try {
      // ① 无身份变化（普通 put）→ 不发 identity.changed
      await client.submit([writeDirective('put', { body: { unrelated: true } })])
      expect(identityEvents(events)).toEqual([])

      // ② 数据世代：put(data) + add_gen → active 移到数据世代；代码世代不变 → data
      const dataDef = { body: { hello: 'data' } }
      const dataHash = H(dataDef as unknown as Json)
      const head = (await client.status()).world_head
      const dataResult = await client.submit([
        {
          kind: 'write',
          request: {
            id: `data-${randomUUID()}`,
            op: 'batch',
            target: { expect_pos: head.hash },
            args: {
              ops: [
                { op: 'put', args: dataDef },
                {
                  op: 'add_gen',
                  args: { id: 'toy', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
                },
              ],
            },
            by: 'client',
          },
        },
      ])
      expect(dataResult.status).toBe('done')
      expect(identityEvents(events)).toEqual([
        { identity: 'toy', kind: 'data', active: dataHash, prev: null },
      ])

      // ③ 代码世代：put(commit) + add_gen → 代码世代 active 变 → code
      const commitDef = { body: { tree, meta: { name: 'toy', version: '9.9.9' } } }
      const commitHash = H(commitDef as unknown as Json)
      const head2 = (await client.status()).world_head
      const codeResult = await client.submit([
        {
          kind: 'write',
          request: {
            id: `code-${randomUUID()}`,
            op: 'batch',
            target: { expect_pos: head2.hash },
            args: {
              ops: [
                { op: 'put', args: commitDef },
                {
                  op: 'add_gen',
                  args: { id: 'toy', payload: { $n: 0 }, sig: { $n: 0 }, pins: {} },
                },
              ],
            },
            by: 'client',
          },
        },
      ])
      expect(codeResult.status).toBe('done')
      await waitFor(
        () => identityEvents(events).some((event) => event.kind === 'code'),
        'identity.changed code',
      )
      const codeEvent = identityEvents(events).find((event) => event.kind === 'code')
      expect(codeEvent).toEqual({
        identity: 'toy',
        kind: 'code',
        active: commitHash,
        prev: codeGen1,
      })
    } finally {
      client.close()
    }
  })
})
