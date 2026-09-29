// `evolve-shadow`（影子回放提供方）库面：三态影子回放与指标 def。
// 服务不读投影、无写通道、不取时间不用随机：一切输入随 bag / 调用帧 env 传入，
// 一切写经计划值 `{"$directives":[…]}` 交宿主落账；本插件只产指标 def，不写链。

pub mod chain;
pub mod error;
pub mod ledger;
pub mod port;
pub mod protocol;
pub mod shadow;
