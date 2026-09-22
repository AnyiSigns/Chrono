// `memory-retrieval`（记忆检索 · L3 召回）库面：纯计算模块 + 服务协议模块。
// 服务不读投影、无写通道、不取时间：查询 / 工作区 / 预算 / 配置 / memory-store 投影全由调用方随 bag 传入，
// 结果写入 bag.recall（返回值，服务不写世界）；跨插件调用只走反向调用（embedding / memory / model）。

pub mod bag;
pub mod config;
pub mod decay;
pub mod dedup;
pub mod error;
pub mod frames;
pub mod hash;
pub mod port;
pub mod protocol;
pub mod retrieve;
pub mod state;
pub mod vector;
