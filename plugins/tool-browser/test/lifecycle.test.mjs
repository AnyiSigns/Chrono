// 进程生命周期测试：模拟信号（SIGTERM / SIGINT）触发优雅停机，`exit` 触发同步硬杀兜底。
// 用假进程对象 emit，跨平台可测（Windows 无法真实投递 POSIX 信号给子进程）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installShutdownHandlers } from '../execute/lifecycle.ts'

function fakeProc() {
  const listeners = new Map()
  return {
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return this
    },
    emit(event) {
      for (const listener of listeners.get(event) ?? []) listener()
    },
    count(event) {
      return (listeners.get(event) ?? []).length
    },
  }
}

test('SIGTERM / SIGINT 触发优雅停机；exit 触发同步硬杀兜底', () => {
  const proc = fakeProc()
  const events = []
  installShutdownHandlers(proc, {
    shutdown: () => events.push('shutdown'),
    killAllSync: () => events.push('kill'),
  })

  proc.emit('SIGTERM')
  assert.deepEqual(events, ['shutdown'])
  proc.emit('SIGINT')
  assert.deepEqual(events, ['shutdown', 'shutdown'])
  proc.emit('exit')
  assert.deepEqual(events, ['shutdown', 'shutdown', 'kill'])
})

test('三类事件各注册一个监听器', () => {
  const proc = fakeProc()
  installShutdownHandlers(proc, { shutdown: () => {}, killAllSync: () => {} })
  assert.equal(proc.count('SIGTERM'), 1)
  assert.equal(proc.count('SIGINT'), 1)
  assert.equal(proc.count('exit'), 1)
})
