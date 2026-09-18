import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { appendJournal, headOf, loadAnchor, readJournal, replayFull, verifyFull } from '../index.ts'
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
})
