// evolution 包形状 / 内容测试（零依赖，node --test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const readText = (rel) => readFileSync(join(pkgRoot, rel), 'utf8')
const readJson = (rel) => JSON.parse(readText(rel))

const DECL_FIELDS = [
  'identity',
  'schema',
  'implements',
  'methods',
  'pins',
  'start',
  'protocol',
  'restart',
  'health',
  'state',
  'members',
  'commands',
]

const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
])
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples'])

function assertWhitelist(schema, where) {
  assert.ok(schema !== null && typeof schema === 'object' && !Array.isArray(schema), where)
  for (const key of Object.keys(schema)) {
    if (ANNOTATIONS.has(key)) continue
    assert.ok(KEYWORDS.has(key), `${where}.${key} 不在白名单`)
    const value = schema[key]
    switch (key) {
      case 'type':
        assert.equal(typeof value, 'string', `${where}.type`)
        assert.ok(TYPES.has(value), `${where}.type 非法：${value}`)
        break
      case 'properties':
        for (const [name, child] of Object.entries(value)) {
          assertWhitelist(child, `${where}.properties.${name}`)
        }
        break
      case 'items':
        assertWhitelist(value, `${where}.items`)
        break
      case 'required':
        assert.ok(Array.isArray(value) && value.every((x) => typeof x === 'string'), where)
        break
      case 'additionalProperties':
        assert.equal(typeof value, 'boolean', `${where}.additionalProperties 只能布尔`)
        break
      case 'enum':
        assert.ok(Array.isArray(value) && value.length > 0, `${where}.enum`)
        break
      case 'minimum':
      case 'maximum':
        assert.equal(typeof value, 'number', `${where}.${key}`)
        break
      case 'minItems':
      case 'maxItems':
      case 'minLength':
      case 'maxLength':
        assert.ok(Number.isInteger(value) && value >= 0, `${where}.${key}`)
        break
      default:
        break
    }
  }
}

test('plugin.json 12 字段齐全且形态合法', () => {
  const decl = readJson('plugin.json')
  assert.deepEqual(Object.keys(decl).sort(), [...DECL_FIELDS].sort())
  assert.equal(decl.identity, 'evolution')
  assert.equal(decl.schema, 'schema/evolution.json')
  assert.deepEqual(decl.implements, [])
  assert.deepEqual(decl.methods, {})
  assert.deepEqual(decl.pins, {})
  assert.equal(decl.start, '')
  assert.equal(decl.protocol, '1')
  assert.equal(typeof decl.restart, 'object')
  assert.equal(typeof decl.health, 'object')
  assert.equal(decl.state, 'recomputable')
  assert.deepEqual(decl.members, [{ kind: 'schema', path: 'schema/' }])
  assert.deepEqual(decl.commands, [])
})

test('evolution schema 是合法 JSON 且符合白名单子集', () => {
  assertWhitelist(readJson('schema/evolution.json'), 'evolution.schema')
})

test('evolution schema 四条链头齐全（tail + count）', () => {
  const schema = readJson('schema/evolution.json')
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['version', 'trace', 'evidence', 'proposals', 'verdicts'])
  for (const chain of ['trace', 'evidence', 'proposals', 'verdicts']) {
    const slot = schema.properties[chain]
    assert.equal(slot.type, 'object', chain)
    assert.deepEqual(slot.required, ['tail', 'count'], chain)
    assert.ok(slot.properties.tail, `${chain}.tail 缺失`)
    assert.equal(slot.properties.count.type, 'integer', chain)
  }
})

test('trace 条目关键字段齐全（含 steps / eff_log / directives_summary）', () => {
  const trace = readJson('schema/evolution.json').properties.trace_entry
  for (const field of [
    'kind',
    'run',
    'session',
    'workspace_id',
    'graph',
    'steps',
    'directives_summary',
    'ctx_summary',
    'refused_at',
    'branch_not_taken',
    'link_taken',
    'outcome',
    'at',
    'prev',
  ]) {
    assert.ok(trace.properties[field], `trace.${field} 缺失`)
  }
  assert.equal(trace.properties.kind.const, 'trace')
  assert.deepEqual(trace.properties.outcome.enum, ['done', 'refused', 'idle', 'cancelled'])
  const step = trace.properties.steps.items
  for (const field of [
    'node_index',
    'iter',
    'contract_id',
    'chosen_instance',
    'chosen_agent',
    'verdict',
    'refusal',
    'post_failed',
    'l1_iters',
    'l1_maxed',
    'verify',
    'usage',
    'eff_log',
  ]) {
    assert.ok(step.properties[field], `step.${field} 缺失`)
  }
  for (const field of ['step', 'iter', 'port', 'method', 'args_hash', 'result_hash', 'outcome']) {
    assert.ok(step.properties.eff_log.items.properties[field], `eff_log.${field} 缺失`)
  }
  assert.ok(trace.required.includes('workspace_id'), 'workspace_id 必须必填')
})

test('evidence 条目 class 枚举 / cluster_key / traces 齐全', () => {
  const evidence = readJson('schema/evolution.json').properties.evidence_entry
  assert.equal(evidence.properties.kind.const, 'evidence')
  assert.deepEqual(evidence.properties.class.enum, [
    'failure_cluster',
    'post_failure',
    'cost_anomaly',
    'instance_drift',
    'fold_candidate',
    'no_progress',
    'verify_failure',
    'user_request',
  ])
  for (const field of ['code', 'attributable_to', 'workspace_id', 'contract_id']) {
    assert.ok(evidence.properties.cluster_key.properties[field], `cluster_key.${field} 缺失`)
  }
  assert.equal(evidence.properties.traces.items.required[0], 'def')
  assert.ok(evidence.properties.source_message, 'source_message 缺失')
  assert.ok(evidence.properties.n && evidence.properties.window, 'n / window 缺失')
})

test('proposal 条目 evidence_ids 必填非空且 class 枚举齐全', () => {
  const proposal = readJson('schema/evolution.json').properties.proposal_entry
  assert.equal(proposal.properties.kind.const, 'proposal')
  assert.deepEqual(proposal.properties.class.enum, [
    'binding',
    'instance_growth',
    'structure',
    'fold',
  ])
  assert.equal(proposal.properties.evidence_ids.type, 'array')
  assert.equal(proposal.properties.evidence_ids.minItems, 1)
  assert.ok(proposal.required.includes('evidence_ids'))
  assert.equal(proposal.properties.patch.required[0], 'def')
  assert.deepEqual(proposal.properties.by.enum, ['evolve-loop', 'user'])
})

test('verdict 条目 result / gate / adopted_gen 齐全', () => {
  const verdict = readJson('schema/evolution.json').properties.verdict_entry
  assert.equal(verdict.properties.kind.const, 'verdict')
  assert.deepEqual(verdict.properties.result.enum, ['accepted', 'rejected', 'undecided'])
  for (const field of ['mechanical', 'reason', 'shadow', 'human']) {
    assert.ok(verdict.properties.gate.properties[field], `gate.${field} 缺失`)
  }
  assert.deepEqual(verdict.properties.gate.properties.mechanical.enum, ['pass', 'fail'])
  assert.ok(verdict.properties.adopted_gen, 'adopted_gen 缺失')
  assert.ok(verdict.properties.proposal_ids, 'proposal_ids 缺失')
  assert.ok(verdict.properties.evidence_ids, 'evidence_ids 缺失')
})

test('tools/default-body.json 为四条空链', () => {
  assert.deepEqual(readJson('tools/default-body.json'), {
    version: 1,
    trace: { tail: null, count: 0 },
    evidence: { tail: null, count: 0 },
    proposals: { tail: null, count: 0 },
    verdicts: { tail: null, count: 0 },
  })
})

test('.worldignore 声明 test/ 与 tools/', () => {
  const lines = readText('.worldignore')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  assert.ok(lines.includes('test/'))
  assert.ok(lines.includes('tools/'))
})

test('package.json 零依赖且带测试脚本', () => {
  const pkg = readJson('package.json')
  assert.equal(pkg.dependencies, undefined)
  assert.equal(pkg.devDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.scripts.test, 'node --test')
})

test('README 存在且不含计划编号 / 计划文档引用', () => {
  const readme = readText('README.md')
  assert.ok(readme.length > 0)
  assert.ok(!/#\d/.test(readme), 'README 含计划编号样式 #<数字>')
  assert.ok(!readme.includes('docs/plans'), 'README 引用了计划文档')
  assert.ok(!/-plan\.md/.test(readme), 'README 引用了计划文档')
})
