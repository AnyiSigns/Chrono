// `evolve-sweep`（台账清理提供方）库面：轨迹 / 证据窗口保留与清理计划。
// 服务不读投影、无写通道、不取时间不用随机：一切输入随 bag / 调用帧 env 传入，
// 一切写经计划值 `{"$directives":[…]}` 交宿主落账。

pub mod chain;
pub mod error;
pub mod ledger;
pub mod protocol;
pub mod sweep;
pub mod thresholds;
