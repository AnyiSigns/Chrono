// `embedding` 服务进程入口（Rust）：服务协议帧循环（docs/protocol.md §二）。
// manifest 与 plugin.json 同形（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道。
// 模型在握手后后台预加载，避免首个调用承担加载延迟。

mod chunk;
mod frames;
mod model;
mod protocol;
mod tokenizer;

fn main() {
    frames::log(&format!("service started (pid {})", std::process::id()));
    std::thread::spawn(model::preload);
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
