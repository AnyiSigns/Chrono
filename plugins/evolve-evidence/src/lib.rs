// `evolve-evidence`（证据提供方）库面：七类证据聚合 / `record`（user_request 证据）。
// 服务不读投影、无写通道、不取时间不用随机：一切输入随 bag / 调用帧 env 传入，
// 一切写经计划值 `{"$directives":[…]}` 交宿主落账；本插件只产 kind:'evidence' 证据条目，不产提案。

pub mod aggregate;
pub mod chain;
pub mod error;
pub mod evidence;
pub mod ledger;
pub mod port;
pub mod protocol;
pub mod record;
pub mod state;
pub mod thresholds;
