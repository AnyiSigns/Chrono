import { describe, expect, it } from 'vitest'
import { parseEntryArgv, resolveCallTimeoutMs } from '../options.ts'
import { DEFAULT_CALL_TIMEOUT_MS } from '../effect/run-loop.ts'

describe('入口参数解析（boot / host 共用）', () => {
  it('摘出 --root / --call-timeout-ms，其余按序进 rest', () => {
    expect(parseEntryArgv(['start', '--root', 'R', 'run', '--call-timeout-ms', '5', 'x'])).toEqual({
      root: 'R',
      callTimeout: '5',
      rest: ['start', 'run', 'x'],
    })
    expect(parseEntryArgv(['status'])).toEqual({ rest: ['status'] })
  })

  it('已知 flag 缺值：不吞下一枚 flag，timeout 记空串（fail-closed）、root 记缺省', () => {
    expect(parseEntryArgv(['--call-timeout-ms', '--root', 'R'])).toEqual({
      callTimeout: '',
      root: 'R',
      rest: [],
    })
    expect(parseEntryArgv(['--root'])).toEqual({ rest: [] })
    expect(parseEntryArgv(['--call-timeout-ms'])).toEqual({ callTimeout: '', rest: [] })
  })
})

describe('F7 调用超时解析（显式 > env > 常量）', () => {
  it('两路都缺省 → 常量 30s', () => {
    expect(resolveCallTimeoutMs()).toBe(DEFAULT_CALL_TIMEOUT_MS)
    expect(resolveCallTimeoutMs(undefined, '')).toBe(DEFAULT_CALL_TIMEOUT_MS)
  })

  it('显式覆盖 env', () => {
    expect(resolveCallTimeoutMs('1234', '9999')).toBe(1234)
  })

  it('env 次之', () => {
    expect(resolveCallTimeoutMs(undefined, '2500')).toBe(2500)
  })

  it('非法值 fail-closed：0 / 负 / 小数 / 非数 / 显式空串', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '']) {
      expect(() => resolveCallTimeoutMs(bad)).toThrow('bad_call_timeout')
    }
    expect(() => resolveCallTimeoutMs(undefined, '-5')).toThrow('bad_call_timeout')
  })
})
