// `sandbox` 服务进程入口（Rust）：服务协议帧循环（docs/protocol.md §二）。
// manifest 与 plugin.json 同形（服务自述与声明一致）；stdout 只发协议帧，日志走 stderr；
// stdin EOF / 管道断开即自退出。服务不读投影、无写通道。

mod exec;
mod frames;
mod fsop;
mod glob;
mod grant;
mod hash;
mod protocol;
mod tiers;
#[cfg(windows)]
mod win32;

fn main() {
    frames::log(&format!("service started (pid {})", std::process::id()));
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
