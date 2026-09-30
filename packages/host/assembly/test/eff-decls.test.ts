import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { planPack, validateEffDecls, walkEffs } from '../index.ts'
import type { EffDeclContext } from '../index.ts'
import { validatePackage } from '../../validate-package.ts'
import { runSeed } from '../../offline.ts'
import { loadAnchor } from '../../ledger/index.ts'
import { hostPaths } from '../../paths.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'
import { writeTempPackage } from '../../test/test-helpers-ext.ts'
import { TERM_TAGS } from '../../../kernel/index.ts'
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
        [
          'list',
          [
            ['eff', 'p', 'a', ['c', null]],
            ['c', 1],
          ],
        ],
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

    it('c / g / v 的载荷即便形如 eff 头也不下钻（字面量数据）', () => {
      const shaped = ['eff', 'nope', 'm', ['c', null]]
      expect(collectPorts(['c', shaped] as unknown as Json)).toEqual([])
      expect(collectPorts(['g', shaped] as unknown as Json)).toEqual([])
      expect(collectPorts(['v', shaped] as unknown as Json)).toEqual([])
    })
  })

  describe('walkEffs：与内核 TERM_TAGS 对表、未覆盖头 fail-closed', () => {
    const eff = ['eff', 'p', 'a', ['c', null]] as unknown as Json
    const emptyCtx: EffDeclContext = {
      implements: new Set<string>(),
      pins: new Set<string>(),
      methods: {},
      calleeMethodsOf: () => null,
    }

    it('内核 TERM_TAGS 的每个头都被 walkEffs 覆盖（新增原语未同步即失败）', () => {
      for (const tag of TERM_TAGS) {
        const handled = walkEffs([tag] as unknown as Json, () => {})
        expect(handled, tag).toEqual([])
      }
    })

    it('term 承载原语的 term 位置内嵌的 eff 均被找到', () => {
      const cases: Array<[string, Json]> = [
        ['get', ['get', eff, []]],
        ['getOr', ['getOr', ['c', null], [], eff]],
        ['cmp', ['cmp', eff, ['c', null]]],
        ['pred', ['pred', 'eq', eff, ['c', null]]],
        ['arith', ['arith', 'add', eff, ['c', null]]],
        ['if', ['if', ['c', true], eff, ['c', null]]],
        ['fold', ['fold', eff, ['c', null], ['c', null]]],
        ['call', ['call', ['c', '0'.repeat(64)], [eff]]],
        ['list', ['list', [eff]]],
        ['obj', ['obj', { k: eff }]],
        ['eff', eff],
      ] as unknown as Array<[string, Json]>
      for (const [tag, ast] of cases) {
        expect(collectPorts(ast), tag).toEqual(['p.a'])
      }
    })

    it('内核新增原语而本表未覆盖 → walkEffs 记录、validateEffDecls 整包拒 bad_term', () => {
      // 模拟内核向 TERM_TAGS 增一个原语、宿主 walkEffs 未同步：默认分支绝不静默跳过。
      const drift = TERM_TAGS as unknown as Set<string>
      drift.add('futurePrim')
      try {
        const ast = ['futurePrim', eff] as unknown as Json
        expect(walkEffs(ast, () => {})).toEqual(['futurePrim'])
        expect(validateEffDecls(ast, emptyCtx)).toEqual(['bad_term:futurePrim'])
      } finally {
        drift.delete('futurePrim')
      }
    })
  })

  describe('validateEffDecls：自调用与跨身份口径分开', () => {
    const base = {
      implements: new Set(['self']),
      pins: new Set(['remote']),
      methods: { self: ['ok'] },
      calleeMethodsOf: (port: string) => (port === 'remote' ? { remote: ['r'] } : null),
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

    it('同键既 implements 又 pins：按 pins（被调声明）判，与运行期路由同口径', () => {
      const ctx: EffDeclContext = {
        implements: new Set(['dual']),
        pins: new Set(['dual']),
        methods: { dual: ['selfOnly'] },
        calleeMethodsOf: (port) => (port === 'dual' ? { dual: ['remoteOnly'] } : null),
      }
      // 被调声明的方法放行（旧实现按自身 methods 会把合法调用拒掉）
      expect(
        validateEffDecls(['eff', 'dual', 'remoteOnly', ['c', null]] as unknown as Json, ctx),
      ).toEqual([])
      // 自身方法不在被调声明 → 拒（旧实现会放行到运行期）
      expect(
        validateEffDecls(['eff', 'dual', 'selfOnly', ['c', null]] as unknown as Json, ctx),
      ).toEqual(['undeclared_method:dual.selfOnly'])
    })
  })

  describe('seed 级：未覆盖头 fail-closed', () => {
    it('内核新增原语而本表未覆盖 → 整包拒 bad_term，世界未写入', async () => {
      const root = createTempRoot()
      // 模拟内核向 TERM_TAGS 增一个原语、宿主 walkEffs 未同步；入世门禁须整包拒而非放行。
      const drift = TERM_TAGS as unknown as Set<string>
      drift.add('futurePrim')
      try {
        const pkg = writeTempPackage(root, {
          identity: 'toy-future-head',
          implements: [],
          methods: {},
          terms: {
            'x.json': JSON.stringify(['futurePrim', ['eff', 'nope', 'm', ['c', null]]]),
          },
        })
        const report = runSeed(root, [{ name: 'toy-future-head', path: pkg }])
        expect(report.ok).toBe(false)
        expect(report.items[0].reasons).toContain('bad_term:futurePrim')
        const world = loadAnchor(`${root}/state/world/journal.jsonl`).world
        expect(Object.hasOwn(world.ids, 'toy-future-head')).toBe(false)
      } finally {
        drift.delete('futurePrim')
        await cleanupTempRoot(root)
      }
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

    it('同键既 implements 又 pins：门禁按被依赖者方法判（与路由同口径）', async () => {
      const goodRoot = createTempRoot()
      const badRoot = createTempRoot()
      try {
        const provider = (root: string) =>
          writeTempPackage(root, {
            identity: 'dual-provider',
            implements: ['dual.cap'],
            methods: { 'dual.cap': ['remoteOnly'] },
          })
        const caller = (root: string, method: string) =>
          writeTempPackage(root, {
            identity: 'dual-caller',
            implements: ['dual.cap'],
            methods: { 'dual.cap': ['selfOnly'] },
            pins: { 'dual.cap': 'dual-provider' },
            terms: { 'x.json': JSON.stringify(['eff', 'dual.cap', method, ['c', null]]) },
          })

        // 调被依赖者声明的方法：放行（旧实现按自身 methods 会拒）
        expect(
          runSeed(goodRoot, [
            { name: 'dual-provider', path: provider(goodRoot) },
            { name: 'dual-caller', path: caller(goodRoot, 'remoteOnly') },
          ]).ok,
        ).toBe(true)

        // 调自身方法（不在被依赖者声明）：整包拒（旧实现会放行到运行期）
        const report = runSeed(badRoot, [
          { name: 'dual-provider', path: provider(badRoot) },
          { name: 'dual-caller', path: caller(badRoot, 'selfOnly') },
        ])
        expect(report.ok).toBe(false)
        expect(report.items[1].reasons).toContain('undeclared_method:dual.cap.selfOnly')
      } finally {
        await cleanupTempRoot(goodRoot)
        await cleanupTempRoot(badRoot)
      }
    })
  })

  describe('seed 级：one 需求（槽端口）方法名校验', () => {
    it('提供方声明方法：有效通过，无效整包拒 undeclared_method', async () => {
      const root = createTempRoot()
      try {
        const provider = writeTempPackage(root, {
          identity: 'provider',
          implements: ['cap'],
          methods: { cap: ['ok'] },
        })
        const good = writeTempPackage(root, {
          identity: 'consumer',
          needs: { cap: { mode: 'one' } },
          terms: { 'x.json': JSON.stringify(['eff', 'cap', 'ok', ['c', null]]) },
        })
        expect(
          runSeed(root, [
            { name: 'provider', path: provider },
            { name: 'consumer', path: good },
          ]).ok,
        ).toBe(true)

        const bad = writeTempPackage(root, {
          identity: 'consumer',
          needs: { cap: { mode: 'one' } },
          terms: { 'x.json': JSON.stringify(['eff', 'cap', 'ghost', ['c', null]]) },
        })
        const report = runSeed(root, [
          { name: 'provider', path: provider },
          { name: 'consumer', path: bad },
        ])
        expect(report.ok).toBe(false)
        expect(report.items[1].reasons).toContain('undeclared_method:cap.ghost')
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('无拥有方契约时对照提供方有效方法集（methods 缺省无语义）', async () => {
      const root = createTempRoot()
      try {
        // 提供方 implements 但不声明 methods：无拥有方契约 → 方法集为空，任何调用都判未声明
        const provider = writeTempPackage(root, {
          identity: 'provider',
          implements: ['cap'],
          methods: {},
        })
        const consumer = writeTempPackage(root, {
          identity: 'consumer',
          needs: { cap: { mode: 'one' } },
          terms: { 'x.json': JSON.stringify(['eff', 'cap', 'ok', ['c', null]]) },
        })
        const report = runSeed(root, [
          { name: 'provider', path: provider },
          { name: 'consumer', path: consumer },
        ])
        expect(report.ok).toBe(false)
        expect(report.items[1].reasons).toContain('undeclared_method:cap.ok')
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('有拥有方契约时对照契约：提供方不声明方法也能通过', async () => {
      const root = createTempRoot()
      try {
        const owner = writeTempPackage(root, {
          identity: 'owner',
          slots: { cap: { methods: ['ok'] } },
        })
        const provider = writeTempPackage(root, {
          identity: 'provider',
          implements: ['cap'],
          methods: {},
        })
        const consumer = writeTempPackage(root, {
          identity: 'consumer',
          needs: { cap: { mode: 'one' } },
          terms: { 'x.json': JSON.stringify(['eff', 'cap', 'ok', ['c', null]]) },
        })
        const report = runSeed(root, [
          { name: 'owner', path: owner },
          { name: 'provider', path: provider },
          { name: 'consumer', path: consumer },
        ])
        expect(report.ok).toBe(true)
      } finally {
        await cleanupTempRoot(root)
      }
    })

    it('many 端口不在入世做提供方方法校验（由路由期按成员判定）', async () => {
      const root = createTempRoot()
      try {
        const consumer = writeTempPackage(root, {
          identity: 'consumer',
          needs: { hook: { mode: 'many', methods: ['onTurn'] } },
          terms: { 'x.json': JSON.stringify(['eff', 'hook', 'ghost', ['c', null]]) },
        })
        expect(runSeed(root, [{ name: 'consumer', path: consumer }]).ok).toBe(true)
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
              build: [],
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
