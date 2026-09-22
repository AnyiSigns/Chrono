// `evolve-metrics`（指标层 · 证据聚合）库面：纯计算模块 + 服务协议模块。
// 服务不读投影、无写通道、不取时间不用随机：一切输入随 bag / 调用帧 env 传入，
// 一切写经计划值 `{"$directives":[…]}` 交宿主落账；本插件只产 kind:'evidence' 证据条目，不产提案。

pub mod aggregate;
pub mod bag;
pub mod error;
pub mod evidence;
pub mod frames;
pub mod hash;
pub mod plan;
pub mod port;
pub mod protocol;
pub mod record;
pub mod shadow;
pub mod state;
pub mod sweep;
pub mod thresholds;
