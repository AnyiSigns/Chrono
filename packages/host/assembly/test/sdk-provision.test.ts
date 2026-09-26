// SDK 供给单测：框架安装定位、物化树内建链（realpath 指回框架安装）、幂等与坏安装 fail-closed。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { frameworkSdkDir, provisionPluginSdk, provisionRustPluginSdk } from '../sdk-provision.ts'
import { createTempRoot, cleanupTempRoot } from '../../test/test-helpers.ts'

describe('SDK 运行期供给', () => {
  let root: string

  beforeEach(() => {
    root = createTempRoot()
  })

  afterEach(() => cleanupTempRoot(root))

  it('frameworkSdkDir 定位到顶层 plugin-sdk 包', () => {
    const dir = frameworkSdkDir()
    expect(existsSync(join(dir, 'package.json'))).toBe(true)
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
    expect(pkg.name).toBe('plugin-sdk')
  })

  it('物化树内建链，realpath 指回框架安装的 SDK（不在 node_modules 下）', () => {
    const cwd = join(root, 'state', 'runtime', 'materialized', 'a'.repeat(64))
    mkdirSync(cwd, { recursive: true })
    provisionPluginSdk(cwd)
    const target = join(cwd, 'node_modules', 'plugin-sdk')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(realpathSync(target)).toBe(realpathSync(frameworkSdkDir()))
    // 链可解析到包内文件（Node 裸导入据此加载）
    expect(existsSync(join(target, 'index.ts'))).toBe(true)
  })

  it('幂等：重复供给仍指向框架安装', () => {
    const cwd = join(root, 'pkg')
    mkdirSync(cwd, { recursive: true })
    provisionPluginSdk(cwd)
    provisionPluginSdk(cwd)
    const target = join(cwd, 'node_modules', 'plugin-sdk')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(realpathSync(target)).toBe(realpathSync(frameworkSdkDir()))
  })

  it('SDK 目录缺失 → 抛错（调用方按 deps_failed 收口）', () => {
    const cwd = join(root, 'pkg')
    mkdirSync(cwd, { recursive: true })
    expect(() => provisionPluginSdk(cwd, join(root, 'missing-sdk'))).toThrow()
  })

  it('Rust SDK 供给：物化目录两级之上建链，`../../plugin-sdk/rust` 可解析', () => {
    const cwd = join(root, 'state', 'runtime', 'materialized', 'b'.repeat(64))
    mkdirSync(cwd, { recursive: true })
    provisionRustPluginSdk(cwd)
    const target = resolve(cwd, '..', '..', 'plugin-sdk')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(realpathSync(target)).toBe(realpathSync(frameworkSdkDir()))
    // 物化树里的 Cargo.toml 以该相对路径依赖 SDK crate
    expect(existsSync(join(cwd, '..', '..', 'plugin-sdk', 'rust', 'Cargo.toml'))).toBe(true)
  })

  it('Rust SDK 供给幂等：重复供给仍指向框架安装', () => {
    const cwd = join(root, 'state', 'runtime', 'materialized', 'c'.repeat(64))
    mkdirSync(cwd, { recursive: true })
    provisionRustPluginSdk(cwd)
    provisionRustPluginSdk(cwd)
    const target = resolve(cwd, '..', '..', 'plugin-sdk')
    expect(lstatSync(target).isSymbolicLink()).toBe(true)
    expect(realpathSync(target)).toBe(realpathSync(frameworkSdkDir()))
  })

  it('Rust SDK crate 缺失 → 抛错（调用方按 deps_failed 收口）', () => {
    const cwd = join(root, 'state', 'runtime', 'materialized', 'd'.repeat(64))
    mkdirSync(cwd, { recursive: true })
    expect(() => provisionRustPluginSdk(cwd, join(root, 'missing-sdk'))).toThrow()
  })
})
