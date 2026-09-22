// watcher 触发过滤单测：与打包排除同口径，重点覆盖「.worldignore 命中不触发」与
// 「dist/ 等构建产物不触发」——后者是防「构建 → 产物变 → 再换代」死循环的关键。

import { describe, expect, it } from 'vitest'
import { isPackedChange, watchPathSegments } from '../ignore.ts'

describe('watcher 触发过滤（与打包排除同口径）', () => {
  it('.worldignore 命中的路径不触发（前缀匹配，test/ 不误伤 test.js）', () => {
    expect(isPackedChange(['dist', 'app.js'], [['dist']])).toBe(false)
    expect(isPackedChange(['test', 'a.js'], [['test']])).toBe(false)
    expect(isPackedChange(['test.js'], [['test']])).toBe(true)
  })

  it('未命中声明的源码路径触发', () => {
    expect(isPackedChange(['execute', 'main.js'], [['dist']])).toBe(true)
    expect(isPackedChange(['src', 'app.jsx'], [['dist'], ['test']])).toBe(true)
  })

  it('通用排除（node_modules / .git）任一段即不触发', () => {
    expect(isPackedChange(['node_modules', 'x', 'index.js'], [])).toBe(false)
    expect(isPackedChange(['.git', 'HEAD'], [])).toBe(false)
  })

  it('.worldignore 自身变动触发；宿主物化标记不触发', () => {
    expect(isPackedChange(['.worldignore'], [['dist']])).toBe(true)
    expect(isPackedChange(['.chrono-materialized'], [])).toBe(false)
  })

  it('Windows 反斜杠路径同样拆段；空 / 无法定位返回空数组', () => {
    expect(watchPathSegments('dist\\app.js')).toEqual(['dist', 'app.js'])
    expect(watchPathSegments('src/app.jsx')).toEqual(['src', 'app.jsx'])
    expect(watchPathSegments('')).toEqual([])
  })
})
