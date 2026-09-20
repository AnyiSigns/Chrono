// G4 资产面单测：内容寻址入库 / 取回 / 机械引用收集 / 离线回收 / 拒绝非法输入。

import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSET_REF_KIND,
  MAX_ASSET_BYTES,
  collectAssetRefs,
  gcAssets,
  getAsset,
  listAssets,
  putAsset,
} from '../assets.ts'
import type { World } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'

describe('G4 资产面 assets', () => {
  const roots: string[] = []
  afterEach(async () => {
    for (const root of roots.splice(0)) await cleanupTempRoot(root)
  })

  function assetsDir(): string {
    const root = createTempRoot()
    roots.push(root)
    return join(root, 'state', 'assets')
  }

  it('putAsset：内容寻址 + 幂等 + 世界侧引用形状', () => {
    const dir = assetsDir()
    const bytes = Buffer.from('hello chrono', 'utf8')
    const first = putAsset(dir, 'text/plain', bytes.toString('base64'))
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.ref.kind).toBe(ASSET_REF_KIND)
    expect(first.ref.mime).toBe('text/plain')
    expect(first.ref.size).toBe(bytes.length)
    expect(first.ref.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(join(dir, first.ref.sha256))).toBe(true)
    // 同字节再入：幂等同引用，不产生第二份
    const second = putAsset(dir, 'text/plain', bytes.toString('base64'))
    expect(second).toEqual(first)
    expect(listAssets(dir)).toEqual([{ sha256: first.ref.sha256, size: bytes.length }])
  })

  it('getAsset：往返一致；缺失 asset_missing；非 64hex bad_asset（防路径穿越）', () => {
    const dir = assetsDir()
    const bytes = Buffer.from([0, 1, 2, 3, 250, 251, 252])
    const put = putAsset(dir, 'application/octet-stream', bytes.toString('base64'))
    if (!put.ok) throw new Error('put failed')
    const got = getAsset(dir, put.ref.sha256)
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.size).toBe(bytes.length)
    expect(Buffer.from(got.bytes, 'base64').equals(bytes)).toBe(true)
    expect(getAsset(dir, '0'.repeat(64))).toEqual({ ok: false, code: 'asset_missing' })
    expect(getAsset(dir, '../../etc/passwd')).toEqual({ ok: false, code: 'bad_asset' })
    expect(getAsset(dir, 123)).toEqual({ ok: false, code: 'bad_asset' })
  })

  it('putAsset 拒绝：非规范 base64 / URL-safe / 空 mime / 空 bytes / 超限', () => {
    const dir = assetsDir()
    const canonical = Buffer.from('abc').toString('base64')
    expect(putAsset(dir, 'text/plain', '!!!not-base64!!!')).toEqual({
      ok: false,
      code: 'bad_asset',
    })
    expect(putAsset(dir, 'text/plain', 'ab-_')).toEqual({ ok: false, code: 'bad_asset' })
    expect(putAsset(dir, '', canonical)).toEqual({ ok: false, code: 'bad_asset' })
    expect(putAsset(dir, 'text/plain', '')).toEqual({ ok: false, code: 'bad_asset' })
    const tooLarge = Buffer.alloc(MAX_ASSET_BYTES + 1, 1).toString('base64')
    expect(putAsset(dir, 'application/octet-stream', tooLarge)).toEqual({
      ok: false,
      code: 'asset_too_large',
    })
  })

  it('collectAssetRefs：嵌套数组 / 对象里的 kind:asset 机械收集，忽略其它形态', () => {
    const world = {
      defs: {
        a: { body: { kind: 'asset', sha256: 'a'.repeat(64), mime: 'x/y', size: 1 } },
        b: {
          body: [
            'c',
            { nested: [{ kind: 'asset', sha256: 'b'.repeat(64), mime: 'y/z', size: 2 }] },
          ],
        },
        c: { body: { kind: 'inline', sha256: 'c'.repeat(64) } },
        d: { body: { kind: 'asset', sha256: 42 } },
      },
      ids: {},
    } as unknown as World
    expect([...collectAssetRefs(world)].sort()).toEqual(['a'.repeat(64), 'b'.repeat(64)])
  })

  it('gcAssets：只删无引用的 64hex 资产文件；临时文件 / 其它文件不碰', () => {
    const dir = assetsDir()
    mkdirSync(dir, { recursive: true })
    const keep = putAsset(dir, 'text/plain', Buffer.from('keep').toString('base64'))
    const drop = putAsset(dir, 'text/plain', Buffer.from('drop').toString('base64'))
    if (!keep.ok || !drop.ok) throw new Error('put failed')
    const tempName = `${'f'.repeat(64)}.tmp-abc`
    writeFileSync(join(dir, 'not-an-asset.txt'), 'x')
    writeFileSync(join(dir, tempName), 'temp')
    const report = gcAssets(dir, new Set([keep.ref.sha256]))
    expect(report.removed).toEqual([drop.ref.sha256])
    expect(report.kept).toBe(1)
    expect(existsSync(join(dir, keep.ref.sha256))).toBe(true)
    expect(existsSync(join(dir, drop.ref.sha256))).toBe(false)
    // 字节被删时连带删其 mime 旁挂
    expect(existsSync(join(dir, `${drop.ref.sha256}.mime`))).toBe(false)
    expect(existsSync(join(dir, `${keep.ref.sha256}.mime`))).toBe(true)
    expect(existsSync(join(dir, 'not-an-asset.txt'))).toBe(true)
    expect(existsSync(join(dir, tempName))).toBe(true)
  })

  it('gcAssets：清理无对应 64hex 字节文件的孤儿 .mime 旁挂', () => {
    const dir = assetsDir()
    mkdirSync(dir, { recursive: true })
    const orphan = 'a'.repeat(64)
    writeFileSync(join(dir, `${orphan}.mime`), 'text/plain')
    const keep = putAsset(dir, 'text/plain', Buffer.from('keep').toString('base64'))
    if (!keep.ok) throw new Error('put failed')
    const report = gcAssets(dir, new Set([keep.ref.sha256]))
    expect(report.kept).toBe(1)
    expect(existsSync(join(dir, `${orphan}.mime`))).toBe(false)
    expect(existsSync(join(dir, `${keep.ref.sha256}.mime`))).toBe(true)
  })
})
