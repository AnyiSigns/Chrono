// 从同包 `plugin.json` 派生 pins 声明（服务不 import 宿主与内核）。
// 读不到时回落空对象，保证服务仍能起（宿主握手会按声明做机械校验）。

import { packageRootOf, readPluginJson } from 'plugin-sdk'
import type { Rec } from './types.ts'

export const PINS: Rec = (() => {
  const pins = readPluginJson(packageRootOf(import.meta.url))['pins']
  return typeof pins === 'object' && pins !== null && !Array.isArray(pins) ? (pins as Rec) : {}
})()
