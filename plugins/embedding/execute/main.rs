// `embedding` 服务进程入口（Rust）：向量化门面 / 扩展点选择器。
// 不持有模型：读宿主注入的 `embedding-provider` 成员表，按请求 model 经各成员 `describe-models`
// 选提供方，再带 `provider` 反向调用其 `embed` 并原样返回结果（消费方与结果形状不变）。
// stdout 只发协议帧，日志走 stderr；stdin EOF / 管道断开即自退出。

mod protocol;
mod selector;

fn main() {
    plugin_sdk::log(
        "embedding",
        &format!("service started (pid {})", std::process::id()),
    );
    protocol::run_loop(std::io::stdin().lock(), std::io::stdout());
}
