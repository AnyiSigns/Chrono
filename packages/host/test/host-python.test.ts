import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { startHost } from '../host.ts'
import type { HostHandle } from '../host.ts'
import { runReplay, runSeed, runVerify } from '../offline.ts'
import { headOf, loadAnchor, readJournal, replayFull, verifyFull } from '../ledger/index.ts'
import { materializeCommit } from '../assembly/index.ts'
import { hostPaths } from '../paths.ts'
import { H, pos, worldRev } from '../../kernel/index.ts'
import type { Json } from '../../kernel/index.ts'
import { createTempRoot, cleanupTempRoot, readAuditRecords } from './test-helpers.ts'
import { FIXTURE_PYTHON, writeTempPackage } from './test-helpers-ext.ts'
import { connect } from '../../client/index.ts'

/** 命令入口：先发 eff（跨语言调到 toy-python），再返回 plan（plan 里带一条业务 put）。 */
const RUN_TERM: Json = [
  'call',
  ['c', { $ref: 'terms/plan.json' }],
  [['eff', 'toy.python', 'echo', ['c', { n: 1 }]]],
]

const PLAN_TERM: Json = [
  'c',
  {
    $directives: [{ kind: 'write', request: { op: 'put', args: { body: { done: true } } } }],
  },
]

/**
 * 本机可用的 Python 启动命令。宿主经 shell 起服务：Windows 下 `python` 可能是
 * Microsoft Store 别名（cmd 解析不到，exit 9009），`py` 才是可用的真实命令。
 */
function resolvePythonCommand(): string | null {
  for (const cmd of ['py', 'python', 'python3']) {
    try {
      execFileSync(cmd, ['--version'], { stdio: 'ignore', timeout: 5000 })
      return cmd
    } catch {
      // 试下一个候选
    }
  }
  return null
}

const PYTHON = resolvePythonCommand()

describe.runIf(PYTHON !== null)('S4.5 跨语言（Python toy 服务，不改载体）', () => {
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

  /** JS caller：只声明 pins（名 → 身份）与 term，被调能力类与实现语言无关。 */
  function writeCaller(): string {
    return writeTempPackage(root, {
      identity: 'toy-py-caller',
      pins: { 'toy.python': 'toy-python' },
      start: '',
      members: [{ kind: 'term', path: 'terms/' }],
      commands: [{ name: 'toy-py-caller.run', entry: 'terms/run.json' }],
      terms: {
        'plan.json': JSON.stringify(PLAN_TERM),
        'run.json': JSON.stringify(RUN_TERM),
      },
    })
  }

  /**
   * 交付的 fixture start = `py execute/main.py`（本机 cmd 实际可用）。其他平台 / 需要注入覆写时
   * 复制一份临时副本（forceCopy），绝不写仓库 fixture 本体；extraFiles 供测试向包内注入覆写。
   */
  function pythonPackage(
    dirName: string,
    options: { extraFiles?: Record<string, string>; forceCopy?: boolean } = {},
  ): string {
    if (PYTHON === null) throw new Error('本机无可用 Python')
    const extraFiles = options.extraFiles ?? {}
    if (PYTHON === 'py' && options.forceCopy !== true && Object.keys(extraFiles).length === 0) {
      return FIXTURE_PYTHON
    }
    const copy = join(root, 'pkgs', dirName)
    cpSync(FIXTURE_PYTHON, copy, { recursive: true })
    if (PYTHON !== 'py') {
      const decl = JSON.parse(readFileSync(join(copy, 'plugin.json'), 'utf8')) as {
        start: string
      }
      decl.start = `${PYTHON} execute/main.py`
      writeFileSync(join(copy, 'plugin.json'), JSON.stringify(decl, null, 2))
    }
    for (const [rel, content] of Object.entries(extraFiles)) {
      const abs = join(copy, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }
    return copy
  }

  /** 「包就位 + state/plugins.json 一行」：seed 只吃清单，包源由清单给出。 */
  function seedFromPluginsManifest(packages: Array<{ name: string; path: string }>): void {
    writeFileSync(hostPaths(root).pluginsFile, JSON.stringify(packages, null, 2))
    const report = runSeed(root)
    expect(report.ok).toBe(true)
  }

  it('只加包 + 清单一行：连接/握手 → call/result → 回灌 → 落账，链完整可重放', async () => {
    seedFromPluginsManifest([
      { name: 'toy-python', path: pythonPackage('toy-python') },
      { name: 'toy-py-caller', path: writeCaller() },
    ])
    const world = loadAnchor(journalFile()).world
    expect(world.ids['toy-python']).toBeDefined()
    expect(world.ids['toy-py-caller']).toBeDefined()

    const before = readJournal(journalFile()).length
    const handle = await startHost({ root })
    handles.push(handle)
    let headMirror: { seq: number; hash: string | null } | undefined
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const status = await client.status()
      expect(status.loaded.map((x) => x.id as string).sort()).toEqual([
        'toy-py-caller',
        'toy-python',
      ])
      for (const item of status.loaded as Array<{ id: string; gen: string }>) {
        expect(item.gen).toBe(world.ids[item.id].active)
      }
      const result = await client.command('toy-py-caller.run')
      expect(result.status).toBe('done')
      expect(result.observations.map((o) => (o as { kind: string }).kind)).toEqual([
        'eval',
        'write',
      ])
      headMirror = (await client.status()).world_head as { seq: number; hash: string | null }
    } finally {
      client.close()
    }
    await handle.stop()

    const entries = readJournal(journalFile())
    expect(verifyFull(entries).ok).toBe(true)
    expect(headMirror).toEqual(headOf(entries))

    // 审计进旁路侧存：journal 只多一条业务写；业务写不落 ref
    const added = entries.slice(before)
    expect(added).toHaveLength(1)
    const write = added[0]
    expect(write.op).toBe('put')
    expect(write.ref).toBeUndefined()
    const auditBody = readAuditRecords(root)[0].body as { request: Json; result: Json }
    expect(auditBody.request).toMatchObject({
      port: 'toy.python',
      method: 'echo',
      args: { n: 1 },
    })
    expect(auditBody.result).toEqual({
      ok: true,
      value: { impl: 'toy-python', port: 'toy.python', method: 'echo', args: { n: 1 } },
    })

    // 重放保真（S4 已定口径）：同 journal 重放重建出的 def 与落账内容逐字相等；
    // 离线 replay / verify 用独立入口复算，链头与宿主运行态观测一致（跨运行不比 run_id / now）。
    const replayed = replayFull(entries)
    expect(replayed.defs[H(write.args as Json)]).toEqual(write.args as Json)
    const verifyReport = runVerify(root)
    expect(verifyReport.ok).toBe(true)
    const replayReport = runReplay(root)
    expect(replayReport.head).toEqual(headMirror)
    expect(replayReport.worldRev).toBe(verifyReport.worldRev)
    expect(replayReport.worldRev).toBe(worldRev(replayed))
  })

  it('Python 服务静默不回帧 → 超时归 transport_failed → refused，审计进侧存', async () => {
    const silent = pythonPackage('toy-python-silent', {
      extraFiles: { 'service-config.json': JSON.stringify({ callMode: 'silent' }) },
    })
    seedFromPluginsManifest([
      { name: 'toy-python', path: silent },
      { name: 'toy-py-caller', path: writeCaller() },
    ])

    const before = readJournal(journalFile()).length
    const handle = await startHost({ root, callTimeoutMs: 400 })
    handles.push(handle)
    let headMirror: { seq: number; hash: string | null } | undefined
    const client = await connect({ root, timeoutMs: 3000 })
    try {
      const result = await client.command('toy-py-caller.run')
      expect(result.status).toBe('refused')
      expect(result.observations[result.observations.length - 1]).toMatchObject({
        kind: 'refused',
        reasons: ['eff_error'],
      })
      headMirror = (await client.status()).world_head as { seq: number; hash: string | null }
    } finally {
      client.close()
    }

    const entries = readJournal(journalFile())
    // 审计进旁路侧存：无业务写、journal 无增
    expect(entries.slice(before)).toHaveLength(0)
    // 侧存 request 钉住本轮 silent eff
    const audits = readAuditRecords(root)
    expect(audits).toHaveLength(1)
    expect(audits[0].by).toBe('command')
    const auditBody = audits[0].body as { request: Json; result: Json }
    expect(auditBody.request).toMatchObject({
      port: 'toy.python',
      method: 'echo',
      args: { n: 1 },
    })
    expect(auditBody.result).toEqual({ ok: false, error: 'transport_failed' })
    expect(headMirror).toEqual(headOf(entries))
    expect(verifyFull(entries).ok).toBe(true)
  })

  it('.worldignore 排除 __pycache__/：物化树含 Python 源码、不含运行时缓存', () => {
    // 强制临时副本：注入的缓存绝不写进仓库 fixture 本体
    const pkg = pythonPackage('toy-python-ignore', { forceCopy: true })
    mkdirSync(join(pkg, '__pycache__'), { recursive: true })
    mkdirSync(join(pkg, 'execute', '__pycache__'), { recursive: true })
    writeFileSync(join(pkg, '__pycache__', 'stale.cpython-314.pyc'), 'stale-bytecode')
    writeFileSync(join(pkg, 'execute', '__pycache__', 'main.cpython-314.pyc'), 'stale-bytecode')
    expect(existsSync(join(pkg, '__pycache__', 'stale.cpython-314.pyc'))).toBe(true)
    expect(existsSync(join(pkg, 'execute', '__pycache__', 'main.cpython-314.pyc'))).toBe(true)

    expect(runSeed(root, [{ name: 'toy-python', path: pkg }]).ok).toBe(true)
    const world = loadAnchor(journalFile()).world
    const commitHash = world.ids['toy-python'].active as string
    const rootDir = materializeCommit(world, commitHash, hostPaths(root).materializedDir, {
      blobsDir: hostPaths(root).blobsDir,
    })
    expect(rootDir).not.toBeNull()
    expect(existsSync(join(rootDir as string, 'execute', 'main.py'))).toBe(true)
    expect(readFileSync(join(rootDir as string, 'execute', 'main.py'), 'utf8')).toContain(
      'MAX_FRAME_BYTES',
    )
    expect(existsSync(join(rootDir as string, '__pycache__'))).toBe(false)
    expect(existsSync(join(rootDir as string, 'execute', '__pycache__'))).toBe(false)
  })
})
