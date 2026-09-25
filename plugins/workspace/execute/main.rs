// `workspace` 服务进程入口（Rust）：服务协议帧循环（docs/protocol.md §二）。
// manifest 与 plugin.json 同形（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道：body 与槽体由调用方随 args 传入。

mod body;
mod frames;
mod pick;
mod platform;
mod protocol;
mod recent;
mod reveal;
mod store;
#[cfg(windows)]
mod win32;

fn main() {
    frames::log(&format!("service started (pid {})", std::process::id()));
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
