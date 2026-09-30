// 原子落盘的宿主导入面：实现已收敛到平台适配层（`platform/fs.ts`），
// 本模块保留既有导入路径，避免调用方大规模改 import。

export { fsyncDir, writeAllSync, writeFileAtomic, writeFileStaged } from './platform/fs.ts'
