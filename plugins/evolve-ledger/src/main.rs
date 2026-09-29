// `evolve-ledger` 服务进程入口（Rust）：服务协议帧循环（docs/protocol.md §二）。
// manifest 与 plugin.json 同形；stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。
// 服务不读投影、无写通道、不取时间不用随机：一切输入随调用 args 传入。

use evolve_ledger::protocol;

fn main() {
    plugin_sdk::log("evolve-ledger", &format!("service started (pid {})", std::process::id()));
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
