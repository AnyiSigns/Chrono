import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import {
  appendJournal,
  headOf,
  loadAnchor,
  readAllEntries,
  readJournal,
  readJournalTolerant,
  repairJournalTail,
  replayFull,
  verifyFull,
} from '../index.ts'
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTempRoot, createToyPlugin, cleanupTempRoot } from '../../test/test-helpers.ts'

const EMPTY_HEAD = { seq: -1, hash: null as string | null }

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }
type Op =
  | 'put'
  | 'add_identity'
  | 'add_gen'
  | 'set_active'
  | 'retire'
  | 'fork'
  | 'graft'
  | 'batch'
  | 'note'
  | 'snapshot'

function mkEntry(seq: number, prev: string | null, op: Op, args: Json) {
  return { seq, prev, op, args, argsHash: 'h'.repeat(64), by: 'u', at: 1000 + seq }
}

describe('账本 journal', () => {
  const root = createTempRoot()
  const file = join(root, 'state', 'world', 'journal.jsonl')

  afterEach(() => cleanupTempRoot(root))

  it('空日志 → headOf 返回 EMPTY_HEAD，readJournal 返回空数组', () => {
    expect(headOf([])).toEqual(EMPTY_HEAD)
    expect(readJournal(file)).toEqual([])
  })

  it('appendJournal 空数组不产生任何落盘', () => {
    appendJournal(file, [])
    expect(readJournal(file)).toEqual([])
  })

  it('单条 entry 追加后 readJournal 原样返回，headOf 正确', () => {
    const entry = mkEntry(1, null, 'put', { body: { v: 1 } })
    appendJournal(file, [entry])
    const entries = readJournal(file)
    expect(entries).toHaveLength(1)
    expect(entries[0].seq).toBe(1)
    expect(entries[0].prev).toBeNull()
    expect(headOf(entries)).toEqual({ seq: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
  })

  it('loadAnchor 从空文件重建空世界与 EMPTY_HEAD', () => {
    const anchor = loadAnchor(file)
    expect(anchor.head).toEqual(EMPTY_HEAD)
    expect(Object.keys(anchor.world.defs)).toHaveLength(0)
    expect(Object.keys(anchor.world.ids)).toHaveLength(0)
    expect(anchor.entries).toEqual([])
  })

  it('verifyFull 空日志通过，head 为 EMPTY_HEAD，worldRev 为空世界摘要', () => {
    const report = verifyFull([])
    expect(report.ok).toBe(true)
    expect(report.head).toEqual(EMPTY_HEAD)
    expect(typeof report.worldRev).toBe('string')
  })

  it('replayFull 空日志重建空世界', () => {
    const world = replayFull([])
    expect(Object.keys(world.defs)).toHaveLength(0)
    expect(Object.keys(world.ids)).toHaveLength(0)
  })

  it('幂等追加：同内容两次 appendJournal 产生两条 entry，head 推进', () => {
    const entry = mkEntry(1, null, 'put', { body: { v: 1 } })
    appendJournal(file, [entry])
    const entry2 = { ...entry, seq: 2, prev: entry.argsHash }
    appendJournal(file, [entry2])
    const entries = readJournal(file)
    expect(entries).toHaveLength(2)
    expect(headOf(entries).seq).toBe(2)
  })

  it('容错读：末行半截 JSON 被丢弃并报告截断位置，前面的 entry 保留', () => {
    const e1 = mkEntry(1, null, 'put', { body: { v: 1 } })
    const e2 = mkEntry(2, e1.argsHash, 'put', { body: { v: 2 } })
    appendJournal(file, [e1, e2])
    const validBytes = statSync(file).size
    appendFileSync(file, '{"seq":3,"prev":')
    const read = readJournalTolerant(file)
    expect(read.entries).toHaveLength(2)
    expect(read.truncated).toBe(true)
    expect(read.validBytes).toBe(validBytes)
  })

  it('严格读：末行半截 JSON 也抛（verify / replay 不得静默丢末条）', () => {
    const e1 = mkEntry(1, null, 'put', { body: { v: 1 } })
    const e2 = mkEntry(2, e1.argsHash, 'put', { body: { v: 2 } })
    appendJournal(file, [e1, e2])
    appendFileSync(file, '{"seq":3,"prev":')
    expect(() => readJournal(file)).toThrow()
    expect(() => readAllEntries(file, join(root, 'state', 'world', 'cold'))).toThrow()
  })

  it('repairJournalTail：截断撕裂尾到有效前缀，之后 append 不粘行', () => {
    const e1 = mkEntry(1, null, 'put', { body: { v: 1 } })
    const e2 = mkEntry(2, e1.argsHash, 'put', { body: { v: 2 } })
    appendJournal(file, [e1, e2])
    const validBytes = statSync(file).size
    appendFileSync(file, '{"seq":3,"prev":')
    const repaired = repairJournalTail(file)
    expect(repaired.truncated).toBe(true)
    expect(statSync(file).size).toBe(validBytes)
    const e3 = mkEntry(3, e2.argsHash, 'put', { body: { v: 3 } })
    appendJournal(file, [e3])
    const entries = readJournal(file)
    expect(entries).toHaveLength(3)
    expect(headOf(entries).seq).toBe(3)
  })

  it('appendJournal 守卫：文件以半截行结尾（未换行）时拒追加，不粘行', () => {
    const e1 = mkEntry(1, null, 'put', { body: { v: 1 } })
    appendJournal(file, [e1])
    appendFileSync(file, '{"seq":2,"prev":')
    const e2 = mkEntry(2, e1.argsHash, 'put', { body: { v: 2 } })
    expect(() => appendJournal(file, [e2])).toThrow('journal_torn_tail')
  })

  it('中间行损坏仍抛：不得静默读半条', () => {
    const e1 = mkEntry(1, null, 'put', { body: { v: 1 } })
    const e2 = mkEntry(2, e1.argsHash, 'put', { body: { v: 2 } })
    const e3 = mkEntry(3, e2.argsHash, 'put', { body: { v: 3 } })
    appendJournal(file, [e1, e2, e3])
    const lines = readFileSync(file, 'utf8').split('\n')
    lines[1] = '{"broken":'
    writeFileSync(file, lines.join('\n'))
    expect(() => readJournal(file)).toThrow()
    // 带换行的中间损坏即便容错读也抛（只有末段无换行的撕裂尾才容错）
    expect(() => readJournalTolerant(file)).toThrow()
  })
})
