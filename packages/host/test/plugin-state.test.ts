// H4 插件 ③ 目录：state/plugins/<id>/ 的宿主侧保证——统一 GC（删未知身份目录、留已知）、
// 起服务时按身份创建并以 CHRONO_PLUGIN_STATE 注入 spawn env。

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { gcPluginState } from '../plugin-state.ts'
import { createTempRoot, cleanupTempRoot } from './test-helpers.ts'
import { waitFor, writeTempPackage } from './test-helpers-ext.ts'
import type { World } from '../../kernel/index.ts'

function worldWithIds(ids: string[]): World {
  return { defs: {}, ids: Object.fromEntries(ids.map((id) => [id, {}])) } as unknown as World
}

describe('H4 插件 ③ 目录', () => {
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

  it('gcPluginState：删除未知身份目录、保留已知；目录不存在即无操作', () => {
    const pluginsDir = join(root, 'state', 'plugins')
    expect(gcPluginState(pluginsDir, worldWithIds(['known']))).toEqual([])
    mkdirSync(join(pluginsDir, 'known'), { recursive: true })
    mkdirSync(join(pluginsDir, 'ghost'), { recursive: true })
    writeFileSync(join(pluginsDir, 'ghost', 'cache.bin'), 'x')
    const removed = gcPluginState(pluginsDir, worldWithIds(['known']))
    expect(removed).toEqual(['ghost'])
    expect(existsSync(join(pluginsDir, 'known'))).toBe(true)
    expect(existsSync(join(pluginsDir, 'ghost'))).toBe(false)
  })

  it('gcPluginState：原型键目录名不算「已知身份」（hasOwn 判定）', () => {
    const pluginsDir = join(root, 'state', 'plugins')
    mkdirSync(join(pluginsDir, '__proto__'), { recursive: true })
    const removed = gcPluginState(pluginsDir, worldWithIds(['known']))
    expect(removed).toEqual(['__proto__'])
    expect(existsSync(join(pluginsDir, '__proto__'))).toBe(false)
  })

  it('宿主启动 GC：删未知身份目录、保留已知', async () => {
    const known = writeTempPackage(root, {
      identity: 'toy-known',
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      terms: { 'x.json': JSON.stringify(['c', 1]) },
    })
    expect(runSeed(root, [{ name: 'toy-known', path: known }]).ok).toBe(true)
    const pluginsDir = join(root, 'state', 'plugins')
    mkdirSync(join(pluginsDir, 'ghost'), { recursive: true })
    mkdirSync(join(pluginsDir, 'toy-known'), { recursive: true })

    const handle = await startHost({ root })
    handles.push(handle)
    expect(existsSync(join(pluginsDir, 'ghost'))).toBe(false)
    expect(existsSync(join(pluginsDir, 'toy-known'))).toBe(true)
  })

  it('起服务：按身份创建 ③ 目录并以 CHRONO_PLUGIN_STATE 注入 env', async () => {
    const target = join(root, 'env-capture.txt')
    // 自定义服务：把注入的 env 写到固定文件后即退出（握手失败无妨，注入已发生）
    const script =
      `const fs=require('node:fs');` +
      `fs.writeFileSync(${JSON.stringify(target)},String(process.env.CHRONO_PLUGIN_STATE||''));` +
      `process.exit(0);\n`
    const pkg = writeTempPackage(root, {
      identity: 'toy-env',
      implements: ['toy.alpha'],
      start: 'node execute/main.js',
      files: { 'execute/main.js': script },
    })
    expect(runSeed(root, [{ name: 'toy-env', path: pkg }]).ok).toBe(true)

    const handle = await startHost({ root })
    handles.push(handle)
    await waitFor(() => existsSync(target), 'env captured')
    const value = readFileSync(target, 'utf8')
    expect(value).toBe(join(root, 'state', 'plugins', 'toy-env'))
    expect(existsSync(value)).toBe(true)
  })
})
