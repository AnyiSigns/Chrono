import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { planPack, validateEffDecls, walkEffs } from '../index.ts'
import { validatePackage } from '../../validate-package.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import type { Json, World } from '../../../kernel/index.ts'

function emptyWorld(): World {
  return { defs: {}, ids: {} }
}

function collectPorts(ast: Json): string[] {
  const ports: string[] = []
  walkEffs(ast, (port, method) => ports.push(`${String(port)}.${String(method)}`))
  return ports
}

describe('入世期 eff 声明校验', () => {
  describe('walkEffs：只按原语结构下钻，字面量数据不下钻', () => {
    it('识别 if / list / obj / call 内的 eff，忽略 ["c", ...] 载荷里的 eff 形状', () => {
      const ast = [
        'if',
        ['pred', 'eq', ['c', ['eff', 'nope', 'm', ['c', null]]], ['c', null]],
        ['list', [['eff', 'p', 'a', ['c', null]], ['c', 1]]],
        [
          'obj',
          {
            k: ['eff', 'p', 'b', ['c', null]],
            lit: ['c', ['eff', 'nope2', 'm', ['c', null]]],
          },
        ],
      ] as unknown as Json
      expect(collectPorts(ast)).toEqual(['p.a', 'p.b'])
    })

    it('call 的函数侧（["c", $ref]）不下钻，实参表下钻', () => {
      const ast = [
        'call',
        ['c', { $ref: 'terms/__gen/x.json' }],
        [['eff', 'p', 'c', ['c', null]]],
      ] as unknown as Json
      expect(collectPorts(ast)).toEqual(['p.c'])
    })
  })

  describe('validateEffDecls：自调用与跨身份口径分开', () => {
    const base = {
      implements: new Set(['self']),
      pins: new Set(['remote']),
      methods: { self: ['ok'] },
      calleeMethodsOf: (port: string) =>
        port === 'remote' ? { remote: ['r'] } : null,
    }

    it('自调用 method 不在 methods[port] → undeclared_method', () => {
      const issues = validateEffDecls(
        ['eff', 'self', 'ghost', ['c', null]] as unknown as Json,
        base,
      )
      expect(issues).toEqual(['undeclared_method:self.ghost'])
    })

    it('port 既不在 implements 也不在 pins → undeclared_port', () => {
      const issues = validateEffDecls(['eff', 'nope', 'm', ['c', null]] as unknown as Json, base)
      expect(issues).toEqual(['undeclared_port:nope'])
    })

    it('跨身份按被调声明判：命中通过，未命中拒', () => {
      expect(
        validateEffDecls(['eff', 'remote', 'r', ['c', null]] as unknown as Json, base),
      ).toEqual([])
      expect(
        validateEffDecls(['eff', 'remote', 'ghost', ['c', null]] as unknown as Json, base),
      ).toEqual(['undeclared_method:remote.ghost'])
    })

    it('被调声明读不出（calleeMethodsOf 回 null）→ 跳过方法名校验，不新增拒绝语义', () => {
      const ctx = { ...base, calleeMethodsOf: () => null }
      expect(
        validateEffDecls(['eff', 'remote', 'anything', ['c', null]] as unknown as Json, ctx),
      ).toEqual([])
    })
  })

  describe('seed 级：自调用', () => {
    it('method 已声明 → 入世通过；未声明 → 整包拒 undeclared_method', async () => {
      const root = createTempRoot()
      try {
        const good = writeTempPackage(root, {
          identity: 'toy-self',
          implements: ['toy.self'],
          methods: { 'toy.self': ['echo'] },
          terms: { 'x.json': JSON.stringify(['eff', 'toy.self', 'echo', ['c', null]]) },
        })
        expect(runSeed(root, [{ name: 'toy-self', path: good }]).ok).toBe(true)

        const bad = writeTempPackage(root, {
          identity: 'toy-self',
          implements: ['toy.self'],
          methods: { 'toy.self': ['echo'] },
          terms: { 'x.json': JSON.stringify(['eff', 'toy.self', 'ghost', ['c', null]]) },
        })
        const report = runSeed(root, [{ name: 'toy-self', path: bad }])
        expect(report.ok).toBe(false)
        expect(report.items[0].reasons).toContain('undeclared_method:toy.self.ghost')
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('port 未声明 → 整包拒 undeclared_port，世界未写入', async () => {
      const root = createTempRoot()
      try {
        const pkg = writeTempPackage(root, {
          identity: 'toy-noport',
          implements: [],
          methods: {},
          terms: { 'x.json': JSON.stringify(['eff', 'nope', 'm', ['c', null]]) },
        })
        const report = runSeed(root, [{ name: 'toy-noport', path: pkg }])
        expect(report.ok).toBe(false)
        expect(report.items[0].reasons).toContain('undeclared_port:nope')
        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
        expect(Object.hasOwn(world.ids, 'toy-noport')).toBe(false)
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })

  describe('seed 级：跨身份', () => {
    it('调用方 methods 无该端口，但被调身份声明有 → 通过（secrets.list 真实形态）', async () => {
      const root = createTempRoot()
      try {
        const callee = writeTempPackage(root, {
          identity: 'secrets',
          implements: ['secrets'],
          methods: { secrets: ['resolve', 'list'] },
        })
        const caller = writeTempPackage(root, {
          identity: 'ui-settings',
          implements: ['ui-settings'],
          methods: { 'ui-settings': ['view'] },
          pins: { secrets: 'secrets' },
          terms: { 'status.json': JSON.stringify(['eff', 'secrets', 'list', ['c', null]]) },
        })
        const report = runSeed(root, [
          { name: 'secrets', path: callee },
          { name: 'ui-settings', path: caller },
        ])
        expect(report.ok).toBe(true)
        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
        expect(Object.hasOwn(world.ids, 'ui-settings')).toBe(true)
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('被调身份声明无该方法 → 整包拒 undeclared_method', async () => {
      const root = createTempRoot()
      try {
        const callee = writeTempPackage(root, {
          identity: 'secrets',
          implements: ['secrets'],
          methods: { secrets: ['resolve', 'list'] },
        })
        const caller = writeTempPackage(root, {
          identity: 'ui-settings',
          implements: ['ui-settings'],
          methods: { 'ui-settings': ['view'] },
          pins: { secrets: 'secrets' },
          terms: { 'status.json': JSON.stringify(['eff', 'secrets', 'ghost', ['c', null]]) },
        })
        const report = runSeed(root, [
          { name: 'secrets', path: callee },
          { name: 'ui-settings', path: caller },
        ])
        expect(report.ok).toBe(false)
        expect(report.items[1].reasons).toContain('undeclared_method:secrets.ghost')
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('被调身份未入世 → 走既有 unresolved_pin，不新增拒绝语义', async () => {
      const root = createTempRoot()
      try {
        const caller = writeTempPackage(root, {
          identity: 'ui-settings',
          implements: ['ui-settings'],
          methods: { 'ui-settings': ['view'] },
          pins: { secrets: 'secrets' },
          terms: { 'status.json': JSON.stringify(['eff', 'secrets', 'list', ['c', null]]) },
        })
        const report = runSeed(root, [{ name: 'ui-settings', path: caller }])
        expect(report.ok).toBe(false)
        expect(report.items[0].reasons).toEqual(['unresolved_pin'])
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('pin 保留能力 host → 不在世界，跳过方法名校验', async () => {
      const root = createTempRoot()
      try {
        const pkg = writeTempPackage(root, {
          identity: 'toy-hostcall',
          implements: [],
          methods: {},
          pins: { host: 'host' },
          terms: { 'x.json': JSON.stringify(['eff', 'host', 'anything', ['c', null]]) },
        })
        expect(runSeed(root, [{ name: 'toy-hostcall', path: pkg }]).ok).toBe(true)
      } finally {
        await cleanupTempRoot(root)
      }
    })
  })

  describe('pack / validate_package 路径同口径', () => {
    it('planPack（pack）对未声明 port 整包拒', () => {
      const root = createTempRoot()
      try {
        const pkg = writeTempPackage(root, {
          identity: 'toy-pack',
          implements: [],
          methods: {},
          terms: { 'x.json': JSON.stringify(['eff', 'nope', 'm', ['c', null]]) },
        })
        const planned = planPack(emptyWorld(), pkg)
        expect(planned.ok).toBe(false)
        if (!planned.ok) expect(planned.reasons).toContain('undeclared_port:nope')
      } finally {
        cleanupTempRoot(root)
      }
    })

    it('validate_package dry-run 报 undeclared_method（不写世界）', () => {
      const root = createTempRoot()
      try {
        const outcome = validatePackage(
          emptyWorld(),
          join(root, 'state', 'runtime'),
          {
            'plugin.json': JSON.stringify({
              identity: 'toy-validate',
              implements: ['toy.validate'],
              methods: { 'toy.validate': ['ok'] },
              pins: {},
              start: '',
              protocol: '1',
              restart: {},
              health: {},
              state: 'recomputable',
              members: [{ kind: 'term', path: 'terms/' }],
              commands: [],
            }),
            'package.json': JSON.stringify({ name: 'toy-validate', version: '0.0.0' }),
            'terms/x.json': JSON.stringify(['eff', 'toy.validate', 'ghost', ['c', null]]),
          },
          hostPaths(root).blobsDir,
          root,
        )
        expect(outcome.accepted).toBe(true)
        if (outcome.accepted) {
          expect(outcome.report.ok).toBe(false)
          expect(outcome.report.errors.map((e) => e.code)).toContain('undeclared_method')
        }
      } finally {
        cleanupTempRoot(root)
      }
    })
  })
})
