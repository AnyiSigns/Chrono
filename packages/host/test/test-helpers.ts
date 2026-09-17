import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

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

  writeFileSync(join(pkgRoot, 'plugin.json'), JSON.stringify({
    identity: 'toy',
    schema: 'schema/plugin.schema.json',
    implements: ['toy.echo'],
    methods: { 'toy.echo': ['echo'] },
    pins: {},
    start: '',
    protocol: '1',
    restart: { policy: 'on-exit', backoff: 'exponential', max: 5, window_ms: 60000, drain_ms: 5000 },
    health: { probe: 'toy.echo.echo', interval_ms: 10000, timeout_ms: 2000 },
    state: 'recomputable',
    members: [
      { kind: 'term', path: 'terms/' },
      { kind: 'schema', path: 'schema/' },
    ],
    commands: [
      { name: 'toy.hello', entry: 'terms/hello.json', argsSchema: 'schema/args.json' },
      { name: 'toy.eff', entry: 'terms/eff.json' },
    ],
  }, null, 2))

  writeFileSync(join(pkgRoot, 'package.json'), JSON.stringify({
    name: 'toy', version: '0.0.0', private: true, type: 'module',
  }, null, 2))

  writeFileSync(join(pkgRoot, 'README.md'), '# toy plugin\n')

  writeFileSync(join(pkgRoot, 'schema', 'plugin.schema.json'), JSON.stringify({
    type: 'object', title: 'toy identity schema',
  }, null, 2))

  writeFileSync(join(pkgRoot, 'schema', 'args.json'), JSON.stringify({
    type: 'object',
  }, null, 2))

  writeFileSync(join(pkgRoot, 'terms', 'hello.json'), JSON.stringify(['c', 'hello']))
  writeFileSync(join(pkgRoot, 'terms', 'eff.json'), JSON.stringify(['eff', 'toy.echo', 'echo', ['c', 1]]))

  return pkgRoot
}

export function cleanupTempRoot(root: string): void {
  try {
    const { rmSync } = require('node:fs')
    rmSync(root, { recursive: true, force: true })
  } catch {
    // best effort
  }
}
