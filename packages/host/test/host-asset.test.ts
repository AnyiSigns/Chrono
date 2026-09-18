// G4 资产面 E2E：入站 asset.put/get（字节直写资产区、不进世界 / 不推进链）；
// 世界只存 {kind:'asset',sha256,mime,size} 引用；离线 gc 以世界为引用真源回收字节；
// 回放只复现引用：字节被回收后 get → asset_missing。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runAssetGc } from '../offline.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { connect } from '../../client/index.ts'
import type { AssetRef } from '../../client/index.ts'

describe('G4 资产面（入站 put/get + 离线 gc）', () => {
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

  async function start(): Promise<HostHandle> {
    const handle = await startHost({ root })
    handles.push(handle)
    return handle
  }

  /** 把资产引用写进世界（模拟 #1 附件 / #11 消息的引用）。 */
  async function commitRef(
    client: Awaited<ReturnType<typeof connect>>,
    ref: AssetRef,
  ): Promise<void> {
    const result = await client.submit([
      {
        kind: 'write',
        request: {
          id: 'w-asset-ref',
          op: 'put',
          target: { expect_pos: null },
          args: { body: { kind: 'asset', sha256: ref.sha256, mime: ref.mime, size: ref.size } },
          by: 'client',
        },
      },
    ])
    expect(result.status).toBe('done')
  }

  it('put/get 往返；入库不写链；缺失 → asset_missing', async () => {
    await start()
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const before = (await client.status()).world_head
      const payload = Buffer.from([0, 1, 2, 3, 255, 254, 253])
      const ref = await client.putAsset('application/octet-stream', payload)
      expect(ref).toMatchObject({
        kind: 'asset',
        mime: 'application/octet-stream',
        size: payload.length,
      })
      expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/)
      // 资产入库是宿主侧存储操作：不写链、不推进 head
      expect((await client.status()).world_head).toEqual(before)

      await commitRef(client, ref)
      const got = await client.getAsset(ref.sha256)
      expect(got.size).toBe(payload.length)
      expect(Buffer.from(got.bytes).equals(payload)).toBe(true)

      await expect(client.getAsset('0'.repeat(64))).rejects.toMatchObject({
        code: 'asset_missing',
      })
    } finally {
      client.close()
    }
  })

  it('boot assets gc：删无引用字节、留被世界引用的字节；回收后取字节 → asset_missing', async () => {
    const handle = await start()
    const client = await connect({ root, timeoutMs: 3000 })
    const keep = await client.putAsset('text/plain', Buffer.from('keep'))
    const drop = await client.putAsset('text/plain', Buffer.from('drop'))
    await commitRef(client, keep)
    client.close()
    await handle.stop()

    const report = runAssetGc(root)
    expect(report.removed).toEqual([drop.sha256])
    expect(report.kept).toBe(1)
    const assetsDir = join(root, 'state', 'assets')
    expect(existsSync(join(assetsDir, keep.sha256))).toBe(true)
    expect(existsSync(join(assetsDir, drop.sha256))).toBe(false)

    // 回放只复现引用：世界仍有 keep 的引用，drop 的字节已回收
    await start()
    const client2 = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client2.getAsset(keep.sha256)).size).toBe(4)
      await expect(client2.getAsset(drop.sha256)).rejects.toMatchObject({
        code: 'asset_missing',
      })
    } finally {
      client2.close()
    }
  })
})
