// 客户端半边字节读取：路径防护与读回由共享 UI 套件提供，本文件只保留本插件的半边根与结果转名。

import { fileURLToPath } from 'node:url'

export {
  isSafeClientPath,
  clientRelPath,
  readClientFileResult as readClientFile,
} from '@chrono/ui-kit/client-read'

/** 客户端半边根目录（`execute/web/`）。 */
export const CLIENT_WEB_DIR = fileURLToPath(new URL('./web/', import.meta.url))
