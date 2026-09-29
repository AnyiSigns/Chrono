// `evolve-metrics`（指标层 · 残留门面）库面：保留能力类与方法面，算法委派给四个提供方。
// 门面不读投影、无写通道、不取时间不用随机：一切输入随 bag / 调用帧 env 传入，
// 四个方法的实现分别住 `evolve-ledger`（原语）/ `evolve-evidence` / `evolve-sweep` / `evolve-shadow`，
// 经反向 `port.call` 委派；既有消费方（loop-policy / tools）无需改动。

pub mod error;
pub mod port;
pub mod protocol;
