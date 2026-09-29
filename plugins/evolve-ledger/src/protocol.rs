// `evolve-ledger` 服务进程协议面：方法分派（read-chain / patch-plan / thresholds / hash）；
// 帧编解码 / 控制帧 / 线程派发走 plugin-sdk。stdout 只发协议帧，日志走 stderr。
// 服务不读投影、无写通道、无 needs、无 pins：一切输入随 args 传入。

use std::io::{Read, Write};

use serde_json::Value;

use plugin_sdk::{ServiceError, ServiceHandler, ServiceSpec};

use crate::methods;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "evolve-ledger";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（本插件无自有状态）。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 4] = ["read-chain", "patch-plan", "thresholds", "hash"];

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

/// 处理 `call`：能力类门禁 + 方法分派。
pub fn handle_call(method: &str, args: &Value, _env: &Value) -> Result<Value, (String, String)> {
    match method {
        "read-chain" => Ok(methods::read_chain(args)),
        "thresholds" => Ok(methods::thresholds(args)),
        "hash" => methods::hash_method(args),
        "patch-plan" => methods::patch_plan(args),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

/// 调用处理器：无反向调用、无上行事件、无状态。
struct Handler;

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        handle_call(method, args, env).map_err(ServiceError::from)
    }
}

/// 服务入口：帧循环由 SDK 起。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    plugin_sdk::run_service(&SPEC, reader, plugin_sdk::shared_writer(writer), Handler);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "evolve-ledger");
        assert_eq!(value["implements"], json!(["evolve-ledger"]));
        assert_eq!(
            value["methods"]["evolve-ledger"],
            json!(["read-chain", "patch-plan", "thresholds", "hash"])
        );
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        assert_eq!(handle_call("nope", &json!({}), &json!({})).unwrap_err().0, "unknown_method");
    }

    #[test]
    fn read_chain_call_returns_windows() {
        let value = handle_call("read-chain", &json!({"trace_entries": []}), &json!({})).unwrap();
        assert!(value["trace"].as_array().unwrap().is_empty());
        assert_eq!(value["body"], Value::Null);
    }
}
