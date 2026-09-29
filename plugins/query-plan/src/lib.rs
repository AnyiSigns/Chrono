// `query-plan`（查询规划 · L3 召回前置）库面：纯计算模块 + 服务协议模块。
// 只构造查询集：查询构造（顶层 query 拼 L1 goal）+ 可选多查询（eff model.chat 生成子查询，默认关）。
// 不读投影、无写通道、不取时间；一切输入随 args 传入，跨插件调用只走反向调用（model）。

pub mod error;
pub mod plan;
pub mod port;
pub mod protocol;
