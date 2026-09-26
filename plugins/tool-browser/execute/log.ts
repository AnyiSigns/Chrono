// 日志只走 stderr，绝不污染 stdout 的协议帧。

import { makeLogger } from 'plugin-sdk'

export const log = makeLogger('tool-browser')
