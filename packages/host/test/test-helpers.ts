import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** 测试用审计记录（侧存 `state/audit/audit.jsonl` 的一行）。 */
export interface TestAuditRecord {
  seq: number
  at: number
  by: string
  body: unknown
}

/** 读审计旁路侧存（不进世界）；缺文件视为空。 */
export function readAuditRecords(root: string): TestAuditRecord[] {
  const file = join(root, 'state', 'audit', 'audit.jsonl')
  if (!existsSync(file)) return []
  const out: TestAuditRecord[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.length === 0) continue
    out.push(JSON.parse(line) as TestAuditRecord)
  }
  return out
}

export function createTempRoot(): string {
  const root = join(tmpdir(), 'chrono-test', randomUUID())
  mkdirSync(join(root, 'state', 'world'), { recursive: true })
  mkdirSync(join(root, 'state', 'runtime'), { recursive: true })
  mkdirSync(join(root, 'state', 'sock'), { recursive: true })
  return root
}

export function createToyPlugin(root: string): string {
  const pkgRoot = join(root, 'pkg', 'toy')
  mkdirSync(join(pkgRoot, 'schema'), { recursive: true })
  mkdirSync(join(pkgRoot, 'terms'), { recursive: true })
  mkdirSync(join(pkgRoot, 'execute'), { recursive: true })

  writeFileSync(
    join(pkgRoot, 'plugin.json'),
    JSON.stringify(
      {
        identity: 'toy',
        schema: 'schema/plugin.schema.json',
        implements: ['toy.echo'],
        methods: { 'toy.echo': ['echo'] },
        pins: {},
        start: '',
        protocol: '1',
        restart: {
          policy: 'on-exit',
          backoff: 'exponential',
          max: 5,
          window_ms: 60000,
          drain_ms: 5000,
        },
        health: { interval_ms: 10000, timeout_ms: 2000 },
        state: 'recomputable',
        members: [
          { kind: 'term', path: 'terms/' },
          { kind: 'schema', path: 'schema/' },
        ],
        commands: [
          { name: 'toy.hello', entry: 'terms/hello.json', argsSchema: 'schema/args.json' },
          { name: 'toy.eff', entry: 'terms/eff.json' },
        ],
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(pkgRoot, 'package.json'),
    JSON.stringify(
      {
        name: 'toy',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    ),
  )

  writeFileSync(join(pkgRoot, 'README.md'), '# toy plugin\n')

  writeFileSync(
    join(pkgRoot, 'schema', 'plugin.schema.json'),
    JSON.stringify(
      {
        type: 'object',
        title: 'toy identity schema',
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(pkgRoot, 'schema', 'args.json'),
    JSON.stringify(
      {
        type: 'object',
      },
      null,
      2,
    ),
  )

  writeFileSync(join(pkgRoot, 'terms', 'hello.json'), JSON.stringify(['c', 'hello']))
  writeFileSync(
    join(pkgRoot, 'terms', 'eff.json'),
    JSON.stringify(['eff', 'toy.echo', 'echo', ['c', 1]]),
  )

  return pkgRoot
}

/**
 * 清理临时 root。Windows 上被杀进程可能仍短暂占用物化目录 CWD（EPERM/EBUSY），需要重试：
 * 实测 **rmSync 的 maxRetries/retryDelay 对本场景不生效**（1ms 即抛 EPERM），
 * 异步 fs.rm 的同名选项才会真正退避重试，故走异步路径 + 同步兜底。
 * 调用方应 await（vitest 会 await afterEach 回调的返回值）；裸调用退化为 best-effort。
 */
export function cleanupTempRoot(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
}
