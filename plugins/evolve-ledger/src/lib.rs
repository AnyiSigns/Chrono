// `evolve-ledger`（台账原语）库面：链窗口读取 / 写入计划构造 / 阈值解析 / 确定性哈希。
// 纯计算、非 LLM、同输入同输出（不取时间、不用随机、无 needs、无 pins、无 ③）：
// 一切输入随 args 传入，一切写经计划值 `{"$directives":[…]}` 交宿主落账。

pub mod bag;
pub mod error;
pub mod hash;
pub mod methods;
pub mod plan;
pub mod protocol;
pub mod thresholds;
