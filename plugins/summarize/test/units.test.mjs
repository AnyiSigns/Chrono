// `summarize` 纯函数级测试（node --test）：直接 import execute 源码，不 spawn 服务。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asStringList, normalizeText, uniqueStrings } from '../execute/plan.ts'
import {
  deriveSentences,
  emptySummary,
  mergeSummaries,
  parseSummary,
  sentencesOf,
  summaryFromArgs,
  summaryFromSource,
  summaryToJson,
  summaryToL2Json,
  truncate,
  truncateSummary,
} from '../execute/summary.ts'
import { BadArgsError } from 'plugin-sdk'

test('normalizeText / uniqueStrings / asStringList', () => {
  assert.equal(normalizeText('  a   b \n'), 'a b')
  assert.deepEqual(uniqueStrings([' a ', 'a', 'b', '']), ['a', 'b'])
  assert.deepEqual(asStringList(['x', 'y'], 'facts'), ['x', 'y'])
  assert.deepEqual(asStringList(undefined, 'facts'), [])
  assert.throws(() => asStringList('x', 'facts'), BadArgsError)
})

test('sentencesOf / deriveSentences 确定派生', () => {
  assert.deepEqual(sentencesOf('First. Second! Third?'), ['First.', 'Second!', 'Third?'])
  const slice = [
    { role: 'user', content: 'Alpha one. Beta two.' },
    { role: 'assistant', content: 'Gamma three.' },
  ]
  assert.deepEqual(deriveSentences(slice, 2, 100), ['Alpha one.', 'Beta two.'])
  assert.deepEqual(deriveSentences(undefined, 3, 100), [])
})

test('truncate 按 Unicode 码点截断，不劈代理对', () => {
  assert.equal(truncate('abc', 5), 'abc')
  assert.equal(truncate('abcde', 3), 'abc')
  assert.equal(truncate('a😀b', 2), 'a😀')
  const astral = '😀😀😀'
  const cut = truncate(astral, 1)
  assert.equal(cut, '😀')
  assert.equal(Array.from(cut).length, 1)
  assert.notEqual(cut, astral.slice(0, 1))
  assert.equal(astral.slice(0, 1), '\uD83D')
})

test('target_length 一致作用于 summary 解析来源', () => {
  const long = 'x'.repeat(10)
  const parsed = summaryFromSource({ summary: { goal: long, facts: [long, 'short'] } }, 3, 3)
  assert.equal(parsed.goal, 'xxx')
  assert.deepEqual(parsed.facts, ['xxx', 'sho'])
})

test('summaryFromArgs：结构化字段优先，缺失由切片派生', () => {
  const summary = summaryFromArgs(
    {
      goal: '目标',
      facts: ['事实一', '事实一'],
      session_slice: [{ role: 'user', content: 'Derived sentence.' }],
    },
    100,
    3,
  )
  assert.equal(summary.goal, '目标')
  assert.deepEqual(summary.facts, ['事实一'])
  assert.deepEqual(summary.decisions, [])
  assert.deepEqual(summary.next_steps, [])
})

test('summaryFromArgs：无结构化字段时从切片派生 goal 与 facts', () => {
  const summary = summaryFromArgs(
    { session_slice: [{ role: 'user', content: 'Hello world.' }] },
    100,
    3,
  )
  assert.equal(summary.goal, 'Hello world.')
  assert.deepEqual(summary.facts, ['Hello world.'])
})

test('parseSummary / current 截断 / summaryToL2Json：L2 无 next_steps', () => {
  const parsed = parseSummary({ goal: 'g', facts: ['f'], next_steps: ['n'] })
  assert.deepEqual(parsed.facts, ['f'])
  assert.deepEqual(parsed.next_steps, ['n'])
  const clamped = truncateSummary(parsed, 1)
  assert.equal(clamped.goal, 'g')
  const l2 = summaryToL2Json(parsed)
  assert.equal(l2.next_steps, undefined)
  assert.deepEqual(l2.facts, ['f'])
  const l1 = summaryToJson(parsed)
  assert.deepEqual(l1.next_steps, ['n'])
})

test('mergeSummaries：既有 + 去重结果拼接、goal 新值优先、路径合并', () => {
  const existing = { ...emptySummary(), goal: 'old', facts: ['a', 'b'] }
  const incoming = { ...emptySummary(), goal: 'new', facts: ['b', 'c'] }
  const text = mergeSummaries(existing, incoming, { facts: { accepted: ['c'], dedup: 'text' } })
  assert.equal(text.summary.goal, 'new')
  assert.deepEqual(text.summary.facts, ['a', 'b', 'c'])
  assert.equal(text.dedup, 'text')

  const vector = mergeSummaries(existing, incoming, {
    facts: { accepted: ['c'], dedup: 'vector' },
    decisions: { accepted: [], dedup: 'text' },
  })
  assert.equal(vector.dedup, 'vector')

  // 缺 outcome：回落空接受 + 文本路径
  const missing = mergeSummaries(existing, incoming, undefined)
  assert.deepEqual(missing.summary.facts, ['a', 'b'])
  assert.equal(missing.dedup, 'text')
})
