import { describe, expect, it, afterEach } from 'vitest'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { ServiceLink } from '../service-link.ts'
import { FIXTURE_ALPHA } from './test-helpers-ext.ts'

function timeout(ms: number, label: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms))
}

describe('服务协议 ServiceLink（直连 fixture 服务）', () => {
  const children: ChildProcess[] = []

  afterEach(() => {
    for (const child of children) {
      try {
        child.stdin?.end()
      } catch {
        // 已退出
      }
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }
    children.length = 0
  })

  function spawnFixture(cwd: string): ChildProcess {
    const child = spawn(process.execPath, ['execute/main.js'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    children.push(child)
    return child
  }

  it('握手成功：manifest 与 fixture 声明一致', async () => {
    const child = spawnFixture(FIXTURE_ALPHA)
    const link = new ServiceLink(child, { impl: 'toy-alpha', gen: 'g'.repeat(64) })
    const manifest = await link.handshake(2000)
    expect(manifest.v).toBe('1')
    expect(manifest.identity).toBe('toy-alpha')
    expect(manifest.implements).toEqual(['toy.alpha'])
    expect(manifest.methods).toEqual({ 'toy.alpha': ['echo'] })
    expect(manifest.protocol).toBe('1')
    expect(manifest.state).toBe('recomputable')
  })

  it('probe → pong ok，drain → bye', async () => {
    const child = spawnFixture(FIXTURE_ALPHA)
    const link = new ServiceLink(child, { impl: 'toy-alpha', gen: 'g'.repeat(64) })
    await link.handshake(2000)
    const ok = await link.probe(1000)
    expect(ok).toBe(true)
    await link.drain(100, 2000)
  })

  it('link.close() 即 stdin EOF：服务自退出（断连自退出义务）', async () => {
    const child = spawnFixture(FIXTURE_ALPHA)
    const link = new ServiceLink(child, { impl: 'toy-alpha', gen: 'g'.repeat(64) })
    await link.handshake(2000)
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    )
    link.close()
    const code = await Promise.race([exited, timeout(3000, '服务未随 stdin EOF 自退出')])
    expect(code).toBe(0)
  })
})
