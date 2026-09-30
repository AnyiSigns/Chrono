import { describe, expect, it } from 'vitest'
import {
  assertNoEntryRest,
  parseEntryArgv,
  resolveCallTimeoutMs,
  resolveCompactStrict,
  resolveStartWrapper,
  resolveWatch,
} from '../options.ts'
import { DEFAULT_CALL_TIMEOUT_MS } from '../common/call-timeout.ts'

describe('入口参数解析（boot / host 共用）', () => {
  it('摘出 --root / --call-timeout-ms，其余按序进 rest', () => {
    expect(parseEntryArgv(['start', '--root', 'R', 'run', '--call-timeout-ms', '5', 'x'])).toEqual({
      root: 'R',
      callTimeout: '5',
      rest: ['start', 'run', 'x'],
    })
    expect(parseEntryArgv(['status'])).toEqual({ rest: ['status'] })
  })

  it('摘出 --start-wrapper（CLI 形态与超时同规）', () => {
    expect(
      parseEntryArgv(['start', '--start-wrapper', 'sandbox --profile p', '--root', 'R']),
    ).toEqual({
      root: 'R',
      startWrapper: 'sandbox --profile p',
      rest: ['start'],
    })
  })

  it('已知 flag 缺值：不吞下一枚 flag，timeout / wrapper 记空串（fail-closed）、root 记缺省', () => {
    expect(parseEntryArgv(['--call-timeout-ms', '--root', 'R'])).toEqual({
      callTimeout: '',
      root: 'R',
      rest: [],
    })
    expect(parseEntryArgv(['--root'])).toEqual({ rest: [] })
    expect(parseEntryArgv(['--call-timeout-ms'])).toEqual({ callTimeout: '', rest: [] })
    expect(parseEntryArgv(['--start-wrapper'])).toEqual({ startWrapper: '', rest: [] })
  })

  it('--watch 是布尔旗标：不吞下一枚 token', () => {
    expect(parseEntryArgv(['start', '--watch', '--root', 'R'])).toEqual({
      watch: true,
      root: 'R',
      rest: ['start'],
    })
    expect(parseEntryArgv(['start'])).toEqual({ rest: ['start'] })
  })

  it('支持 --flag=value 形态（三种已知 flag，含带空格的包装器值）', () => {
    expect(
      parseEntryArgv([
        'start',
        '--root=R',
        '--call-timeout-ms=5',
        '--start-wrapper=cmd --profile p',
      ]),
    ).toEqual({
      root: 'R',
      callTimeout: '5',
      startWrapper: 'cmd --profile p',
      rest: ['start'],
    })
    // `=` 形态空值仍是 present + 空串（交给 resolver fail-closed）
    expect(parseEntryArgv(['--call-timeout-ms='])).toEqual({ callTimeout: '', rest: [] })
    expect(parseEntryArgv(['--start-wrapper='])).toEqual({ startWrapper: '', rest: [] })
  })

  it('= 形态的值可显式以 -- 开头；空格形态仍不吞下一枚 flag', () => {
    expect(parseEntryArgv(['--start-wrapper=--sandbox --profile p'])).toEqual({
      startWrapper: '--sandbox --profile p',
      rest: [],
    })
    // 空格形态：值以 -- 开头视为缺值（不吞 --foo），wrapper 记空串交给 resolver fail-closed
    expect(parseEntryArgv(['--start-wrapper', '--foo'])).toEqual({
      startWrapper: '',
      rest: ['--foo'],
    })
  })

  it('未知 flag 原样进 rest（交调用方处置，不静默吞）', () => {
    expect(parseEntryArgv(['start', '--bogus', 'x'])).toEqual({ rest: ['start', '--bogus', 'x'] })
    expect(parseEntryArgv(['--bogus=1'])).toEqual({ rest: ['--bogus=1'] })
  })

  it('assertNoEntryRest：宿主入口不接受位置参数 / 未知 flag', () => {
    expect(() => assertNoEntryRest([])).not.toThrow()
    expect(() => assertNoEntryRest(['--bogus'])).toThrow('unknown_entry_arg')
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

  it('非法值 fail-closed：0 / 负 / 小数 / 非数 / 显式空串 / 超计时器上限', () => {
    for (const bad of ['0', '-1', '1.5', 'abc', '', '2147483648', '1e300']) {
      expect(() => resolveCallTimeoutMs(bad)).toThrow('bad_call_timeout')
    }
    expect(() => resolveCallTimeoutMs(undefined, '-5')).toThrow('bad_call_timeout')
  })
})

describe('服务启动包装器解析（显式 > env > 无）', () => {
  it('两路都缺省 → undefined（零行为变化）', () => {
    expect(resolveStartWrapper()).toBeUndefined()
    expect(resolveStartWrapper(undefined, '')).toBeUndefined()
  })

  it('显式覆盖 env', () => {
    expect(resolveStartWrapper('sandbox --profile p', 'other')).toBe('sandbox --profile p')
  })

  it('env 次之', () => {
    expect(resolveStartWrapper(undefined, 'sandbox')).toBe('sandbox')
  })

  it('非法值 fail-closed：空 / 纯空白 / 含 NUL / 含换行', () => {
    for (const bad of ['', '   ', 'a\0b', 'a\nb', 'a\rb']) {
      expect(() => resolveStartWrapper(bad)).toThrow('bad_start_wrapper')
    }
    expect(() => resolveStartWrapper(undefined, '  ')).toThrow('bad_start_wrapper')
  })
})

describe('源码 watcher 开关解析（显式 > env > 关）', () => {
  it('两路都缺省 → 关（生产常驻不无条件监听文件系统）', () => {
    expect(resolveWatch()).toBe(false)
    expect(resolveWatch(undefined, '')).toBe(false)
  })

  it('显式 --watch 覆盖 env 的假值', () => {
    expect(resolveWatch(true, '0')).toBe(true)
    expect(resolveWatch(true)).toBe(true)
  })

  it('env 真值打开（大小写 / 空白不敏感）', () => {
    for (const on of ['1', 'true', 'TRUE', ' yes ', 'On']) {
      expect(resolveWatch(undefined, on)).toBe(true)
    }
  })

  it('env 假值关', () => {
    for (const off of ['0', 'false', 'NO', 'off']) {
      expect(resolveWatch(undefined, off)).toBe(false)
    }
  })

  it('无法识别的 env 值 fail-closed', () => {
    expect(() => resolveWatch(undefined, 'maybe')).toThrow('bad_watch')
  })
})

describe('严格回收开关解析（显式 > env > 关）', () => {
  it('两路都缺省 → 关（strict 仅引用图完备时安全，默认保守）', () => {
    expect(resolveCompactStrict()).toBe(false)
    expect(resolveCompactStrict(undefined, '')).toBe(false)
  })

  it('显式 --strict 覆盖 env 的假值', () => {
    expect(resolveCompactStrict(true, '0')).toBe(true)
  })

  it('env 真值打开 / 假值关', () => {
    for (const on of ['1', 'true', 'On']) expect(resolveCompactStrict(undefined, on)).toBe(true)
    for (const off of ['0', 'false', 'off'])
      expect(resolveCompactStrict(undefined, off)).toBe(false)
  })

  it('无法识别的 env 值 fail-closed', () => {
    expect(() => resolveCompactStrict(undefined, 'maybe')).toThrow('bad_compact_strict')
  })
})
