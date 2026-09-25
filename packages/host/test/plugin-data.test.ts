// 插件 ④ 目录：state/data/<id>/ 的宿主侧保证——声明 durable 才按身份建目录并以 CHRONO_PLUGIN_DATA
// 注入 spawn env；未声明者不建目录、不注入；不安全身份名 fail-closed；统一 GC 只删目录名不在
// 当前世界身份集中的项（与 ③ 分开，不参与世代窗口回收）。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { ensurePluginDataDir, gcPluginData, PluginDataError } from '../plugin-data.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import type { World } from '../../kernel/index.ts'

function worldWithIds(ids: string[]): World {
  return { defs: {}, ids: Object.fromEntries(ids.map((id) => [id, {}])) } as unknown as World
}

/** 把注入的指定环境变量写到固定文件后即退出（握手失败无妨，注入已发生）。 */
function envCaptureScript(target: string, variable: string): string {
  return (
    `const fs=require('node:fs');` +
    `fs.writeFileSync(${JSON.stringify(target)},String(process.env.${variable}||''));` +
    `process.exit(0);\n`
  )
}

describe('插件 ④ 目录', () => {
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

  it('ensurePluginDataDir：按身份建目录；不安全身份名 fail-closed', () => {
    const dataRoot = join(root, 'state', 'data')
    const dir = ensurePluginDataDir(dataRoot, 'known')
    expect(dir).toBe(join(root, 'state', 'data', 'known'))
    expect(existsSync(dir)).toBe(true)
    for (const bad of ['../evil', 'a/b', 'a\\b', '', 'CON', '__proto__', 'host', 'a.']) {
      expect(() => ensurePluginDataDir(dataRoot, bad), `身份名 ${JSON.stringify(bad)} 应被拒`).toThrow(
        PluginDataError,
      )
    }
  })

  it('gcPluginData：删未知身份目录、保留已知；目录不存在即无操作', () => {
    const dataRoot = join(root, 'state', 'data')
    expect(gcPluginData(dataRoot, worldWithIds(['known']))).toEqual({ removed: [], failed: [] })
    ensurePluginDataDir(dataRoot, 'known')
    ensurePluginDataDir(dataRoot, 'ghost')
    const report = gcPluginData(dataRoot, worldWithIds(['known']))
    expect(report.removed).toEqual(['ghost'])
    expect(report.failed).toEqual([])
    expect(existsSync(join(dataRoot, 'known'))).toBe(true)
    expect(existsSync(join(dataRoot, 'ghost'))).toBe(false)
  })

  it('起服务：声明 durable → 建 state/data/<id>/ 并注入 CHRONO_PLUGIN_DATA', async () => {
    const target = join(root, 'data-env-capture.txt')
    const pkg = writeTempPackage(root, {
      identity: 'toy-durable',
      implements: ['toy.dur'],
      start: 'node execute/main.js',
      state: 'durable',
      files: { 'execute/main.js': envCaptureScript(target, 'CHRONO_PLUGIN_DATA') },
    })
    expect(runSeed(root, [{ name: 'toy-durable', path: pkg }]).ok).toBe(true)

    const handle = await startHost({ root })
    handles.push(handle)
    await waitFor(() => existsSync(target), 'CHRONO_PLUGIN_DATA captured')
    const value = readFileSync(target, 'utf8')
    expect(value).toBe(join(root, 'state', 'data', 'toy-durable'))
    expect(existsSync(value)).toBe(true)
  })

  it('起服务：未声明 durable → 不建 state/data/<id>/、不注入 CHRONO_PLUGIN_DATA', async () => {
    const target = join(root, 'data-env-capture.txt')
    const pkg = writeTempPackage(root, {
      identity: 'toy-recompute',
      implements: ['toy.rec'],
      start: 'node execute/main.js',
      files: { 'execute/main.js': envCaptureScript(target, 'CHRONO_PLUGIN_DATA') },
    })
    expect(runSeed(root, [{ name: 'toy-recompute', path: pkg }]).ok).toBe(true)

    const handle = await startHost({ root })
    handles.push(handle)
    await waitFor(() => existsSync(target), 'env captured')
    expect(readFileSync(target, 'utf8')).toBe('')
    expect(existsSync(join(root, 'state', 'data', 'toy-recompute'))).toBe(false)
  })
})
