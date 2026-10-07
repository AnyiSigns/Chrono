// 平台适配层出口：集中所有 OS 特定原语（地址、链接、原子落盘、进程树终止、权限）。
// 约定：`process.platform` 分支只住本目录，其余模块一律经这里调用。

export { isWindows } from './os.ts'
export { socketAddress } from './socket.ts'
export {
  chmodIfSupported,
  fsyncDir,
  symlinkDirOrJunction,
  writeAllSync,
  writeFileAtomic,
  writeFileStaged,
} from './fs.ts'
export { detachedProcessGroup, isProcessAlive, killProcessTree } from './process.ts'
