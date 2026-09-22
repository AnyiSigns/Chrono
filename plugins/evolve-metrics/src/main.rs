// `evolve-metrics` 服务进程入口（Rust）：服务协议帧循环（docs/protocol.md §二）。
// manifest 与 plugin.json 同形；stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。
// 服务不读投影、无写通道；唯一 pin = 保留身份 `host`（shadow 经 host.audit 读历史审计）。

use evolve_metrics::{frames, protocol};

fn main() {
    frames::log(&format!("service started (pid {})", std::process::id()));
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
