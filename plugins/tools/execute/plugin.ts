// 从同包 `plugin.json` 取本插件 `pins` 的逻辑端口名（= `port.call` 的 port，按发出者 pins 路由）。
// manifest 派生由 plugin-sdk 承担；服务不 import 宿主与内核。

import { isRecord, packageRootOf, readPluginJson } from 'plugin-sdk'

const PLUGIN = readPluginJson(packageRootOf(import.meta.url))

/** 本插件 `pins` 的逻辑端口名（= `port.call` 的 port，按发出者 pins 路由）。 */
export const PINS: string[] = isRecord(PLUGIN['pins']) ? Object.keys(PLUGIN['pins']) : []
