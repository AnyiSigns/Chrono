// `memory-retrieval` 服务进程入口（Rust）：服务协议帧循环。
// manifest 与 plugin.json 同形；stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。
// 服务不读投影、无写通道；反向调用 embedding / memory / model 三个 pin。

use memory_retrieval::{frames, protocol};

fn main() {
    frames::log(&format!("service started (pid {})", std::process::id()));
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
