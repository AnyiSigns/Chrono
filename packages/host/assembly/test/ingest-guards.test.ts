import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { planIngest } from '../index.ts'
import { runSeed } from '../../offline.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Json, World } from '../../../kernel/index.ts'

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

function asObject(value: Json): Record<string, Json> {
  return value as Record<string, Json>
}

function firstOf(value: Json): Record<string, Json> {
  return (value as Json[])[0] as Record<string, Json>
}

describe('入世守卫：声明路径逃逸包根 → bad_plugin_decl', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('schema / 命令入口 / 参数 schema / members 路径含 ..、绝对路径、盘符、反斜杠 → 整包拒', () => {
    const pkgRoot = writeTempPackage(root, {
      identity: 'toy-path',
      start: 'node execute/main.js',
      implements: ['toy.path'],
      commands: [{ name: 'toy.path.cmd', entry: 'terms/e.json', argsSchema: 'schema/args.json' }],
      members: [{ kind: 'term', path: 'terms/' }],
    })
    const pluginFile = join(pkgRoot, 'plugin.json')
    const cases: Array<{ label: string; patch: (decl: Record<string, Json>) => void }> = [
      {
        label: "schema='../outside.json'",
        patch: (decl) => {
          decl.schema = '../outside.json'
        },
      },
      {
        label: 'schema=null（不得以 null 占位，应省略）',
        patch: (decl) => {
          decl.schema = null
        },
      },
      {
        label: "commands[0].entry='C:/abs.json'（盘符）",
        patch: (decl) => {
          firstOf(decl.commands).entry = 'C:/abs.json'
        },
      },
      {
        label: "commands[0].entry='/abs.json'（绝对）",
        patch: (decl) => {
          firstOf(decl.commands).entry = '/abs.json'
        },
      },
      {
        label: "commands[0].argsSchema='schema/..\\win.json'（含 .. 与反斜杠）",
        patch: (decl) => {
          firstOf(decl.commands).argsSchema = 'schema/..\\win.json'
        },
      },
      {
        label: "members[0].path='../escape'",
        patch: (decl) => {
          firstOf(decl.members).path = '../escape'
        },
      },
      {
        label: "members[0].path='/abs/'（绝对）",
        patch: (decl) => {
          firstOf(decl.members).path = '/abs/'
        },
      },
      {
        label: "exclusive='port'（非数组）",
        patch: (decl) => {
          decl.exclusive = 'port'
        },
      },
      {
        label: "exclusive=['gpu']（未知资源类，宿主无法保证换人序安全）",
        patch: (decl) => {
          decl.exclusive = ['gpu']
        },
      },
    ]

    for (const testCase of cases) {
      const decl = JSON.parse(readFileSync(pluginFile, 'utf8')) as Json
      testCase.patch(asObject(decl))
      writeFileSync(pluginFile, JSON.stringify(decl, null, 2))
      const planned = planIngest(emptyWorld(), root, { name: 'toy-path', path: pkgRoot })
      expect(planned.ok, testCase.label).toBe(false)
      if (!planned.ok) expect(planned.reasons, testCase.label).toEqual(['bad_plugin_decl'])
    }

    // runSeed 面同样整包拒、不写 batch
    const decl = JSON.parse(readFileSync(pluginFile, 'utf8')) as Json
    asObject(decl).schema = '../outside.json'
    writeFileSync(pluginFile, JSON.stringify(decl, null, 2))
    const report = runSeed(root, [{ name: 'toy-path', path: pkgRoot }])
    expect(report.items[0].status).toBe('failed')
    expect(report.items[0].reasons).toEqual(['bad_plugin_decl'])
  })
})
