// `sandbox` 服务进程协议面（薄门面）：保留原公开方法名，把算法委派给三个提供方插件。
// `exec` / `exec_start` / `fsop` 先经 `sandbox-policy.resolve` 解析档位判定，随 bag 的 `resolved`
// 字段下传；`exec_poll` / `exec_kill` / `session_close` 直接转发；`capabilities` 合并两提供方自述。
// 判定 / 强制均在提供方进程内完成，门面不做额外往返（每个方法至多一跳）。

use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::{CallEnv, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::port::Providers;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "sandbox";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 7] = [
    "exec",
    "exec_start",
    "exec_poll",
    "exec_kill",
    "session_close",
    "fsop",
    "capabilities",
];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：方法分派到提供方。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &CallEnv,
    providers: &Providers,
) -> Result<Value, (String, String)> {
    let _ = env;
    match method {
        "capabilities" => capabilities(providers),
        "exec" | "exec_start" => forward_gated(providers, "sandbox-exec", method, args),
        "fsop" => forward_gated(providers, "sandbox-fs", method, args),
        "exec_poll" | "exec_kill" | "session_close" => {
            forward(providers, "sandbox-exec", method, args)
        }
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
}

/// 直接转发一个方法到目标提供方。
fn forward(
    providers: &Providers,
    port: &str,
    method: &str,
    args: &Value,
) -> Result<Value, (String, String)> {
    providers
        .call(port, method, args.clone())
        .map_err(|err| (err.code, err.message))
}

/// 先解析档位判定（`sandbox-policy.resolve`），把结果以 `resolved` 注入 bag 后转发；
/// 判定不可得（如策略服务未就绪）时不注入，由提供方内建同源判定兜底。
fn forward_gated(
    providers: &Providers,
    port: &str,
    method: &str,
    args: &Value,
) -> Result<Value, (String, String)> {
    let mut forwarded = args.clone();
    if let Ok(resolved) = providers.call("sandbox-policy", "resolve", args.clone()) {
        if let Some(object) = forwarded.as_object_mut() {
            object.insert("resolved".to_string(), resolved);
        }
    }
    forward(providers, port, method, &forwarded)
}

/// `capabilities`：合并 `sandbox-exec`（平台 / 实现 / Linux 隔离层）与 `sandbox-fs`（文本匹配口径）自述。
fn capabilities(providers: &Providers) -> Result<Value, (String, String)> {
    let exec = forward(providers, "sandbox-exec", "capabilities", &json!({}))?;
    let fs = forward(providers, "sandbox-fs", "capabilities", &json!({}))?;
    let mut merged = exec;
    if let (Some(target), Some(text)) = (merged.as_object_mut(), fs.get("text")) {
        target.insert("text".to_string(), text.clone());
    }
    Ok(merged)
}

/// 调用处理器：把 `port.result` / `port.error` 帧结算进反向通道，其余交帧循环。
struct Handler {
    providers: Arc<Providers>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        let env = CallEnv::parse_value(env);
        handle_call(method, args, &env, &self.providers).map_err(ServiceError::from)
    }

    fn intercept(&self, frame: &Value) -> bool {
        self.providers.settle(frame)
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: std::io::Read, W: std::io::Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = plugin_sdk::shared_writer(writer);
    let providers = Arc::new(Providers::new(shared.clone()));
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { providers });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "sandbox");
        assert_eq!(value["implements"], json!(["sandbox"]));
        assert_eq!(
            value["methods"]["sandbox"],
            json!(["exec", "exec_start", "exec_poll", "exec_kill", "session_close", "fsop", "capabilities"])
        );
        assert_eq!(value["state"], "recomputable");
    }
}
