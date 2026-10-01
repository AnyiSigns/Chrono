// `evolve-metrics`（指标层）库面：证据聚合（aggregate）/ 用户请求记录（record）/
// 台账清理（sweep）/ 影子回放（shadow）四方法就地实现。
// 不读投影、无写通道、不取时间不用随机：一切输入随 bag / 调用帧 env 传入，
// 一切写经计划值 `{"$directives":[…]}` 交宿主落账；链原语（read-chain / patch-plan /
// thresholds / hash）经反向 `port.call` 委派 evolve-ledger；历史审计经 host.audit 读。
// 既有消费方（loop-policy / tools）无需改动。

pub mod aggregate;
pub mod chain;
pub mod error;
pub mod evidence;
pub mod ledger;
pub mod port;
pub mod protocol;
pub mod record;
pub mod shadow;
pub mod state;
pub mod sweep;
pub mod thresholds;
