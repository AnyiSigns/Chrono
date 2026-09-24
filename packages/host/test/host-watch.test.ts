// 源码 watcher E2E：宿主运行中改插件源码 → 自动入世换代 → 新进程接管 / 数据热生效 /
// 内容未变不换代 / 构建失败旧版本继续服务；`dist/` 变动不触发二次换代（死循环防护）。
// 诊断经运维日志 / journal / 服务回值 pid 取值；链逐字节可校验。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runSeed } from '../offline.ts'
import { readJournal } from '../ledger/index.ts'
import { hostPaths } from '../paths.ts'
import { createTempRoot, cleanupTempRoot, readAuditRecords } from './test-helpers.ts'
import {
  isPidAlive,
  readLifecycle,
  waitFor,
  waitForLifecycle,
  writeTempPackage,
} from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'
import type { Entry, Json } from '../../kernel/index.ts'

/** 自身能力调用：命令入口 term 发一条 eff 打到本身份的 `toy.alpha.echo`（自能力路由）。 */
const RUN_TERM: Json = ['eff', 'toy.alpha', 'echo', ['c', { n: 1 }]]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('源码 watcher 热更（默认关，显式打开）', () => {
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

  function lifecycleFile(): string {
    return hostPaths(root).lifecycleFile
  }

  function writeManifest(pkg: string): void {
    writeFileSync(
      join(root, 'state', 'plugins.json'),
      JSON.stringify([{ name: 'toy-alpha', path: pkg }]),
    )
  }

  /** 末条审计（旁路侧存）的 result。 */
  function lastAuditResult(): Json | null {
    const records = readAuditRecords(root)
    const body = records[records.length - 1]?.body as { result?: Json } | undefined
    return body?.result ?? null
  }

  /** 末条审计 result 的 value.pid（fixture 服务默认回值带 pid）。 */
  function lastServicePid(): number {
    const result = lastAuditResult() as { value?: { pid?: number } } | null
    const pid = result?.value?.pid
    expect(typeof pid).toBe('number')
    return pid as number
  }

  function writePackage(worldignore?: string[]): string {
    return writeTempPackage(root, {
      identity: 'toy-alpha',
      implements: ['toy.alpha'],
      methods: { 'toy.alpha': ['echo'] },
      start: 'node execute/main.js',
      members: [
        { kind: 'execute', path: 'execute/' },
        { kind: 'term', path: 'terms/' },
      ],
      commands: [{ name: 'toy-alpha.run', entry: 'terms/run.json' }],
      terms: { 'run.json': JSON.stringify(RUN_TERM) },
      ...(worldignore === undefined ? {} : { worldignore }),
    })
  }

  async function startWatching(pkg: string, logs: string[]): Promise<HostHandle> {
    writeManifest(pkg)
    expect(runSeed(root, [{ name: 'toy-alpha', path: pkg }]).ok).toBe(true)
    const handle = await startHost({ root, watch: true, watchLog: (line) => logs.push(line) })
    handles.push(handle)
    return handle
  }

  it('代码改动自动换代重起；内容未变不换代；dist/ 变动不触发二次换代', async () => {
    const pkg = writePackage(['dist/'])
    const logs: string[] = []
    await startWatching(pkg, logs)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-alpha.run')).status).toBe('done')
      const pid1 = lastServicePid()

      // ① 代码改动（execute 成员）→ 起新服务、旧服务 drain
      appendFileSync(join(pkg, 'execute', 'main.js'), '\n// watch v2\n')
      await waitForLifecycle(
        lifecycleFile(),
        (r) =>
          r.kind === 'service' &&
          r.event === 'exit' &&
          r.impl === 'toy-alpha' &&
          r.reason === 'superseded',
        '代码换代旧服务退出',
        20000,
      )
      await waitFor(
        () => logs.some((line) => line.includes('已重建并接管')),
        'watcher 接管线',
        20000,
      )
      expect((await client.command('toy-alpha.run')).status).toBe('done')
      const pid2 = lastServicePid()
      expect(pid2).not.toBe(pid1)
      expect(isPidAlive(pid1)).toBe(false)

      // ② 内容未变：同内容重写 → 不推进链头
      const mainPath = join(pkg, 'execute', 'main.js')
      const beforeUnchanged = readJournal(journalFile()).length
      writeFileSync(mainPath, readFileSync(mainPath, 'utf8'))
      await sleep(1200)
      expect(readJournal(journalFile()).length).toBe(beforeUnchanged)

      // ③ dist/ 变动（.worldignore 命中）→ 不触发二次换代
      const beforeDist = readJournal(journalFile()).length
      mkdirSync(join(pkg, 'dist'), { recursive: true })
      writeFileSync(join(pkg, 'dist', 'app.js'), 'built output')
      appendFileSync(join(pkg, 'dist', 'app.js'), '\n// churn\n')
      await sleep(1200)
      expect(readJournal(journalFile()).length).toBe(beforeDist)
    } finally {
      client.close()
    }
  }, 60000)

  it('数据（term）改动热生效：进程不动、无换代退出', async () => {
    const pkg = writePackage()
    const logs: string[] = []
    await startWatching(pkg, logs)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-alpha.run')).status).toBe('done')
      const pid1 = lastServicePid()

      writeFileSync(
        join(pkg, 'terms', 'run.json'),
        JSON.stringify(['eff', 'toy.alpha', 'echo', ['c', { n: 2 }]]),
      )
      await waitForLifecycle(
        lifecycleFile(),
        (r) => r.kind === 'host' && r.event === 'watch_applied' && r.impl === 'toy-alpha',
        '数据换代热生效',
        20000,
      )
      expect(
        readLifecycle(lifecycleFile()).some(
          (r) => r.kind === 'service' && r.event === 'exit' && r.impl === 'toy-alpha',
        ),
      ).toBe(false)
      expect((await client.command('toy-alpha.run')).status).toBe('done')
      expect(lastServicePid()).toBe(pid1)
    } finally {
      client.close()
    }
  }, 40000)

  it('新世代构建失败：旧世代继续服务，无换代退出', async () => {
    const pkg = writePackage()
    const logs: string[] = []
    await startWatching(pkg, logs)
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      expect((await client.command('toy-alpha.run')).status).toBe('done')
      const pid1 = lastServicePid()

      // 代码改动 + 新世代声明一个必然失败的构建步骤
      const declPath = join(pkg, 'plugin.json')
      const decl = JSON.parse(readFileSync(declPath, 'utf8')) as Record<string, unknown>
      decl['build'] = [{ cmd: 'node', args: ['missing-build-script.js'] }]
      writeFileSync(declPath, JSON.stringify(decl, null, 2))
      appendFileSync(join(pkg, 'execute', 'main.js'), '\n// watch v2 with failing build\n')

      await waitForLifecycle(
        lifecycleFile(),
        (r) =>
          r.kind === 'service' &&
          r.event === 'start_failed' &&
          r.impl === 'toy-alpha' &&
          r.reason === 'deps_failed',
        '新世代构建失败',
        25000,
      )
      await waitFor(
        () => logs.some((line) => line.includes('旧版本继续服务')),
        'watcher 失败线',
        20000,
      )
      // 旧服务仍在服务：可调用、pid 不变、无 superseded 退出
      expect((await client.command('toy-alpha.run')).status).toBe('done')
      expect(lastServicePid()).toBe(pid1)
      expect(isPidAlive(pid1)).toBe(true)
      expect(
        readLifecycle(lifecycleFile()).some(
          (r) =>
            r.kind === 'service' &&
            r.event === 'exit' &&
            r.impl === 'toy-alpha' &&
            r.reason === 'superseded',
        ),
      ).toBe(false)
    } finally {
      client.close()
    }
  }, 60000)
})
