// `evolve-ledger`（台账原语 + 指标层）库面：
// 台账原语：链窗口读取 / 写入计划构造 / 阈值解析 / 确定性哈希。
// 指标层：证据聚合（aggregate）/ 用户请求记录（record）/ 台账清理（sweep）/ 影子回放（shadow）。
// 纯计算、非 LLM、同输入同输出（不取时间、不用随机）：
// 一切输入随 args / bag / 调用帧 env 传入，一切写经计划值 `{"$directives":[…]}` 交宿主落账。
// 链原语就地调用（同一二进制），历史审计经保留身份 `host` 的 `host.audit` 读。

pub mod aggregate;
pub mod bag;
pub mod chain;
pub mod error;
pub mod evidence;
pub mod hash;
pub mod ledger;
pub mod methods;
pub mod plan;
pub mod port;
pub mod protocol;
pub mod record;
pub mod shadow;
pub mod state;
pub mod sweep;
pub mod thresholds;
