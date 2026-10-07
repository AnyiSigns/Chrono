import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  WORLDS_ENV,
  findWorldByAlias,
  listWorlds,
  registerWorld,
  resolveWorldRef,
  unregisterWorld,
} from '../worlds.ts'

describe('全局世界注册表', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chrono-worlds-'))
    file = join(dir, 'worlds.json')
    process.env[WORLDS_ENV] = file
  })

  afterEach(() => {
    delete process.env[WORLDS_ENV]
    rmSync(dir, { recursive: true, force: true })
  })

  it('register / list / find / unregister', () => {
    expect(listWorlds()).toEqual([])
    registerWorld('a', join(dir, 'wa'))
    registerWorld('b', join(dir, 'wb'))
    expect(listWorlds().map((entry) => entry.alias)).toEqual(['a', 'b'])
    expect(findWorldByAlias('a')?.root).toBe(resolve(join(dir, 'wa')))
    expect(unregisterWorld('a')).toBe(true)
    expect(unregisterWorld('a')).toBe(false)
    expect(listWorlds().map((entry) => entry.alias)).toEqual(['b'])
  })

  it('resolveWorldRef：别名优先；未命中按路径解析', () => {
    registerWorld('prod', join(dir, 'prod'))
    expect(resolveWorldRef('prod')).toBe(resolve(join(dir, 'prod')))
    expect(resolveWorldRef('./rel')).toBe(resolve(process.cwd(), './rel'))
  })

  it('registerWorld 覆盖同别名', () => {
    registerWorld('x', join(dir, 'one'))
    registerWorld('x', join(dir, 'two'))
    expect(findWorldByAlias('x')?.root).toBe(resolve(join(dir, 'two')))
    expect(listWorlds()).toHaveLength(1)
  })

  it('非法别名 fail-closed', () => {
    expect(() => registerWorld('bad/alias', dir)).toThrow('bad_alias')
  })

  it('坏注册表 → bad_worlds_registry', () => {
    writeFileSync(file, '{ broken')
    expect(() => listWorlds()).toThrow('bad_worlds_registry')
  })
})
