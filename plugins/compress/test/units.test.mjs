// `compress` 逻辑级测试：直接 import execute 源码（不 spawn 服务），用假提供方后端注入。
// 摘要形状 / 派生 / 合并 / 语义 / 去重的真实行为住各提供方插件测试；此处只测消费方编排与端口契约。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combineDedup, createHandlers, TTL_MS } from '../execute/methods.ts'
import { normalizeText, uniqueStrings } from '../execute/plan.ts'
import { BadArgsError } from '../execute/types.ts'
import { dedupResponse, summarizeResponse } from './fakes.mjs'
import { memoryFixture } from './driver.mjs'

/** 内存假 short-memory 后端：read 回整份、apply 逐键置 / 删。 */
function fakeShortMemory(initial = memoryFixture()) {
  const memory = structuredClone(initial)
  return {
    memory,
    backend: {
      read: async () => structuredClone(memory),
      apply: async (args) => {
        for (const [id, record] of Object.entries(args?.set_sessions ?? {})) {
          if (record === null) delete memory.sessions[id]
          else memory.sessions[id] = record
        }
        for (const id of args?.del_sessions ?? []) delete memory.sessions[id]
        for (const [id, record] of Object.entries(args?.set_workspaces ?? {})) {
          if (record === null) delete memory.workspaces[id]
          else memory.workspaces[id] = record
        }
        for (const id of args?.del_workspaces ?? []) delete memory.workspaces[id]
        return { ok: true, changed: 1 }
      },
    },
  }
}

/** 假摘要后端：按端口方法转发到 fakes 的确定性实现。 */
function fakeSummarizeBackend() {
  return {
    derive: async (args, targetLength, extractItems) =>
      summarizeResponse('derive', {
        args,
        target_length: targetLength,
        extract_items: extractItems,
      }).summary,
    parse: async (record) => summarizeResponse('parse', { record }).summary,
    current: async (record, targetLength) =>
      summarizeResponse('current', { record, target_length: targetLength }).summary,
    sentences: async (slice, limit, targetLength) =>
      summarizeResponse('sentences', { session_slice: slice, limit, target_length: targetLength })
        .sentences,
    merge: async (existing, incoming, outcomes) =>
      summarizeResponse('merge', { existing, incoming, outcomes }),
    toL1: async (summary) => summarizeResponse('to_l1', { summary }).record,
    toL2: async (summary) => summarizeResponse('to_l2', { summary }).record,
  }
}

function fakeSemanticBackend(response) {
  return { summarize: async () => response }
}

function fakeDedupBackend() {
  return { dedup: async (incoming, reference) => dedupResponse({ incoming, reference }) }
}

const ENV = { run: 'r', thread: 't', now: 1_700_000_000_000 }
const EXPIRES = new Date(1_700_000_000_000 + TTL_MS).toISOString()

function handlersWith(overrides = {}) {
  return createHandlers({ summarize: fakeSummarizeBackend(), ...overrides })
}

test('normalizeText / uniqueStrings', () => {
  assert.equal(normalizeText('  a   b \n'), 'a b')
  assert.deepEqual(uniqueStrings([' a ', 'a', 'b', '']), ['a', 'b'])
})

test('combineDedup：任一段向量即报 vector，全文本才报 text', () => {
  assert.equal(combineDedup('vector', 'text'), 'vector')
  assert.equal(combineDedup('text', 'vector'), 'vector')
  assert.equal(combineDedup('vector', 'vector'), 'vector')
  assert.equal(combineDedup('text', 'text'), 'text')
})

test('summarize（algorithmic）：写 L1 到 short-memory，保留其他会话 / 工作区', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  const value = await handlers.summarize(
    { conversation: 'c-1', covered_upto: 'msg-9', goal: 'G', facts: ['f1', 'f2'] },
    ENV,
  )
  assert.equal(value.ok, true)
  assert.equal(value.kind, 'summarize')
  assert.equal(value.covered_upto, 'msg-9')
  assert.equal(store.memory.sessions['c-1'].summary.goal, 'G')
  assert.equal(store.memory.sessions['c-1'].covered_upto, 'msg-9')
  assert.equal(store.memory.sessions['c-1'].expires_at, EXPIRES)
  assert.deepEqual(store.memory.sessions['c-keep'], memoryFixture().sessions['c-keep'])
  assert.deepEqual(store.memory.workspaces, memoryFixture().workspaces)
  assert.equal(value.$directives, undefined)
})

test('summarize：缺 conversation → BadArgsError', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  await assert.rejects(() => handlers.summarize({}, ENV), BadArgsError)
})

test('summarize：去重经注入的 dedup 后端（向量路径报 vector）', async () => {
  const store = fakeShortMemory()
  store.memory.sessions['c-1'] = {
    summary: {
      goal: '',
      decisions: [],
      facts: ['alpha'],
      open_questions: [],
      files: [],
      next_steps: [],
    },
    covered_upto: 'msg-1',
    at: '2020-01-01T00:00:00.000Z',
    expires_at: '2020-01-02T00:00:00.000Z',
  }
  const dedup = {
    dedup: async (incoming, reference) => ({
      accepted: incoming.filter((item) => !reference.includes(item)),
      dedup: 'vector',
    }),
  }
  const handlers = handlersWith({ shortMemory: store.backend, dedup })
  const value = await handlers.summarize({ conversation: 'c-1', facts: ['alpha!', 'beta'] }, ENV)
  assert.equal(value.dedup, 'vector')
  assert.deepEqual(store.memory.sessions['c-1'].summary.facts, ['alpha', 'alpha!', 'beta'])
})

test('summarize：dedup 后端缺失 → 回落精确文本（text）', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  const value = await handlers.summarize({ conversation: 'c-1', facts: ['a', 'a', 'b'] }, ENV)
  assert.equal(value.dedup, 'text')
  assert.deepEqual(store.memory.sessions['c-1'].summary.facts, ['a', 'b'])
})

test('summarize：dedup 后端失败 → 回落精确文本，不炸本轮', async () => {
  const store = fakeShortMemory()
  const dedup = {
    dedup: async () => {
      throw new Error('down')
    },
  }
  const handlers = handlersWith({ shortMemory: store.backend, dedup })
  const value = await handlers.summarize({ conversation: 'c-1', facts: ['a', 'b'] }, ENV)
  assert.equal(value.ok, true)
  assert.equal(value.dedup, 'text')
})

test('compact：写 L1 并触发 extract 写 L2（2–3 条）', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  const value = await handlers.compact(
    {
      conversation: 'c-1',
      workspace: 'w-1',
      goal: 'G',
      facts: ['one', 'two', 'three'],
      decisions: ['decide'],
    },
    ENV,
  )
  assert.equal(store.memory.sessions['c-1'].summary.goal, 'G')
  const items = store.memory.workspaces['w-1'].summary.facts
  assert.ok(items.length >= 2 && items.length <= 3, `items=${items.length}`)
  assert.deepEqual(store.memory.workspaces['w-keep'], memoryFixture().workspaces['w-keep'])
  assert.equal(value.kind, 'compact')
  assert.ok(value.items.length >= 2 && value.items.length <= 3)
})

test('extract：2–3 条不重复；全重复回 all_duplicate', async () => {
  const store = fakeShortMemory()
  store.memory.workspaces['w-1'] = {
    summary: { goal: '', decisions: [], facts: ['dup', 'dup2'], open_questions: [], files: [] },
    sources: [],
    at: '2020-01-01T00:00:00.000Z',
  }
  const handlers = handlersWith({ shortMemory: store.backend })
  const value = await handlers.extract(
    { workspace: 'w-1', summary: { facts: ['dup', 'dup2', 'new1', 'new2', 'new3'] } },
    ENV,
  )
  assert.deepEqual(value.items, ['new1', 'new2', 'new3'])

  const dupOnly = await handlers.extract(
    { workspace: 'w-1', summary: { facts: ['dup', 'dup2'] }, session_slice: [] },
    ENV,
  )
  assert.equal(dupOnly.reason, 'all_duplicate')
})

test('extract：候选不足 2 条 → insufficient_content', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  const value = await handlers.extract({ workspace: 'w-1', summary: { facts: [] } }, ENV)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'insufficient_content')
})

test('semantic 模式：经注入语义后端出摘要；模型失败作数据', async () => {
  const store = fakeShortMemory()
  const model = fakeSemanticBackend({ summary: { goal: 'M', facts: ['mf1', 'mf2'] } })
  const handlers = handlersWith({ shortMemory: store.backend, semantic: model })
  const value = await handlers.summarize(
    { conversation: 'c-1', mode: 'semantic', model_config: { base_url: 'x' } },
    ENV,
  )
  assert.equal(value.summary.goal, 'M')

  const failing = handlersWith({
    shortMemory: fakeShortMemory().backend,
    semantic: fakeSemanticBackend({ error: { code: 'model_server_error', message: 'boom' } }),
  })
  const failed = await failing.summarize(
    { conversation: 'c-1', mode: 'semantic', model_config: { base_url: 'x' } },
    ENV,
  )
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'model_server_error')
  assert.equal(failed.$directives, undefined)
})

test('semantic 模式：未接语义后端 → model_unavailable', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  const value = await handlers.summarize({ conversation: 'c-1', mode: 'semantic' }, ENV)
  assert.equal(value.ok, false)
  assert.equal(value.error.code, 'model_unavailable')
})

test('target_length 一致作用于 semantic 输出与既有 L1', async () => {
  const store = fakeShortMemory()
  store.memory.sessions['c-1'] = {
    summary: {
      goal: '',
      decisions: [],
      facts: ['oldfactlong'],
      open_questions: [],
      files: [],
      next_steps: [],
    },
    covered_upto: null,
    at: '2020-01-01T00:00:00.000Z',
    expires_at: '2020-01-02T00:00:00.000Z',
  }
  const semantic = fakeSemanticBackend({ summary: { goal: 'aaaaaa', facts: ['bbbbbb'] } })
  const handlers = handlersWith({ shortMemory: store.backend, semantic })
  const value = await handlers.summarize(
    { conversation: 'c-1', mode: 'semantic', model_config: { base_url: 'x' }, target_length: 3 },
    ENV,
  )
  assert.equal(value.summary.goal, 'aaa')
  assert.deepEqual(value.summary.facts, ['old', 'bbb'])
})

test('persist:false 只算不写', async () => {
  const store = fakeShortMemory()
  const handlers = handlersWith({ shortMemory: store.backend })
  const before = JSON.stringify(store.memory)
  const value = await handlers.summarize(
    { conversation: 'c-1', goal: 'G', facts: ['f'], persist: false },
    ENV,
  )
  assert.equal(value.summary.goal, 'G')
  assert.equal(JSON.stringify(store.memory), before)
})
