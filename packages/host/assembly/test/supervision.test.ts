// terminateChild：Windows 用 `taskkill /T /F` 杀进程树。`spawn` 失败是异步 'error' 事件，
// 紧随的同步 catch 覆盖不到；本测试受控注入 spawn 失败，验证回退到 `child.kill()` 且无未捕获异常。

import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn() }
})

import { spawn } from 'node:child_process'
import { terminateChild } from '../supervision.ts'

const spawnMock = vi.mocked(spawn)

class FakeKiller extends EventEmitter {
  readonly unref = vi.fn()
}

function fakeChild(): { child: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const kill = vi.fn()
  return { child: { pid: 4242, kill } as unknown as ChildProcess, kill }
}

describe('terminateChild（Windows taskkill 路径）', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // 强制走 Windows 分支，使用例在任意平台可复现该缺陷
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    spawnMock.mockReset()
  })

  afterEach(() => {
    if (platform !== undefined) Object.defineProperty(process, 'platform', platform)
  })

  it('taskkill spawn 异步失败（error 事件）→ 回退 child.kill，不抛未捕获异常', () => {
    const killer = new FakeKiller()
    spawnMock.mockReturnValue(killer as unknown as ChildProcess)
    const { child, kill } = fakeChild()

    terminateChild(child)
    // 失败发生在 spawn 之后：必须挂了 'error' 监听，否则未捕获异常会炸宿主
    expect(killer.listenerCount('error')).toBeGreaterThan(0)
    expect(() => killer.emit('error', new Error('spawn taskkill ENOENT'))).not.toThrow()
    expect(kill).toHaveBeenCalledTimes(1)
    expect(killer.unref).toHaveBeenCalledTimes(1)
  })

  it('taskkill 正常启动：不抢跑 child.kill（保留原语义）', () => {
    const killer = new FakeKiller()
    spawnMock.mockReturnValue(killer as unknown as ChildProcess)
    const { child, kill } = fakeChild()

    terminateChild(child)
    expect(kill).not.toHaveBeenCalled()
    expect(killer.unref).toHaveBeenCalledTimes(1)
  })

  it('spawn 同步抛出 → 回退 child.kill', () => {
    spawnMock.mockImplementation(() => {
      throw new Error('spawn sync failed')
    })
    const { child, kill } = fakeChild()

    terminateChild(child)
    expect(kill).toHaveBeenCalledTimes(1)
  })

  it('pid 缺席：不做任何动作', () => {
    const { child, kill } = fakeChild()
    ;(child as { pid?: number }).pid = undefined
    terminateChild(child)
    expect(spawnMock).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })
})
