import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endsWithNewline, readJsonlFile } from '../jsonl.ts'

describe('common/jsonl', () => {
  let dir: string
  const file = (): string => join(dir, 'x.jsonl')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chrono-jsonl-'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('缺文件视为空', () => {
    expect(readJsonlFile(file(), { parse: JSON.parse, strict: true })).toEqual({
      items: [],
      truncated: false,
      validBytes: 0,
    })
  })

  it('逐行解析并回报有效前缀字节数', () => {
    writeFileSync(file(), '1\n2\n')
    const read = readJsonlFile(file(), { parse: JSON.parse, strict: true })
    expect(read.items).toEqual([1, 2])
    expect(read.truncated).toBe(false)
    expect(read.validBytes).toBe(4)
  })

  it('末段无换行的坏行按撕裂尾丢弃并回报有效前缀', () => {
    writeFileSync(file(), '1\n{"bad"')
    const read = readJsonlFile(file(), { parse: JSON.parse, strict: true })
    expect(read.items).toEqual([1])
    expect(read.truncated).toBe(true)
    expect(read.validBytes).toBe(2)
  })

  it('末段是完整 JSON 但缺尾换行：按撕裂尾丢弃，有效前缀不含该段', () => {
    writeFileSync(file(), '{"a":1}')
    // strict 只作用于带换行的坏行，不影响末段撕裂判定：两路同判
    expect(readJsonlFile(file(), { parse: JSON.parse, strict: true })).toEqual({
      items: [],
      truncated: true,
      validBytes: 0,
    })
    expect(readJsonlFile(file(), { parse: JSON.parse, strict: false })).toEqual({
      items: [],
      truncated: true,
      validBytes: 0,
    })
  })

  it('前有完整行、末段完整 JSON 缺尾换行：末段丢弃，有效前缀止于前一行', () => {
    writeFileSync(file(), '1\n{"a":1}')
    const read = readJsonlFile(file(), { parse: JSON.parse, strict: true })
    expect(read.items).toEqual([1])
    expect(read.truncated).toBe(true)
    expect(read.validBytes).toBe(2)
  })

  it('带换行的坏行：strict 上抛，非 strict 跳过', () => {
    writeFileSync(file(), '1\nbad\n2\n')
    expect(() => readJsonlFile(file(), { parse: JSON.parse, strict: true })).toThrow()
    const read = readJsonlFile(file(), { parse: JSON.parse, strict: false })
    expect(read.items).toEqual([1, 2])
    expect(read.truncated).toBe(false)
  })

  it('endsWithNewline：缺文件 / 空文件为 true，非换行结尾为 false', () => {
    expect(endsWithNewline(file())).toBe(true)
    writeFileSync(file(), '')
    expect(endsWithNewline(file())).toBe(true)
    writeFileSync(file(), '1')
    expect(endsWithNewline(file())).toBe(false)
    writeFileSync(file(), '1\n')
    expect(endsWithNewline(file())).toBe(true)
  })
})
