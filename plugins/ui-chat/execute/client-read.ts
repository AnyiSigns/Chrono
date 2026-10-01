// 客户端半边只读交付的路径防护与读回由共享 UI 套件提供，本文件只做本地转发。

export {
  isSafeClientPath,
  resolveClientPath,
  readClientFileText as readClientFile,
} from '@chrono/ui-kit/client-read'
