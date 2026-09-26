// `tool-fs` 服务进程协议面：方法分派（describe / invoke）；帧编解码 / 控制帧 / 线程派发 /
// 反向调用应答结算走 plugin-sdk。stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：
// 所需世界数据全由调用方随 bag 传入；触盘全部经反向调用 sandbox.fsop。

use std::io::{Read, Write};
use std::sync::Arc;

use serde_json::{json, Value};

use plugin_sdk::{PortLink, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::describe;
use crate::invoke;
use crate::port::{FsopBackend, RemoteFsop};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "tool-fs";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["describe", "invoke"];

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

/// 处理 `call`：能力类门禁 + 方法分派（describe / invoke）。
pub fn handle_call(
    method: &str,
    args: &Value,
    backend: &dyn FsopBackend,
) -> Result<Value, (String, String)> {
    match method {
        "describe" => Ok(describe::describe()),
        "invoke" => Ok(invoke::invoke(args, backend)),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

/// 调用处理器：领域后端 + 反向调用通道（应答结算 / 关闭收口）。
struct Handler {
    backend: Arc<dyn FsopBackend>,
    link: Arc<PortLink>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, _env: &Value) -> Result<Value, ServiceError> {
        handle_call(method, args, self.backend.as_ref()).map_err(ServiceError::from)
    }

    fn intercept(&self, frame: &Value) -> bool {
        self.link.settle(frame)
    }

    fn on_close(&self) {
        self.link.fail_all("transport_failed");
    }
}

/// 服务入口：帧循环由 SDK 起（`call` 独立线程执行，控制帧不被阻塞）。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = plugin_sdk::shared_writer(writer);
    let link = Arc::new(
        PortLink::new(Arc::clone(&shared), "tool-fs").with_timeout_code("tool_timeout"),
    );
    let backend: Arc<dyn FsopBackend> = Arc::new(RemoteFsop::new(Arc::clone(&link)));
    run_loop_with(reader, shared, link, backend);
}

/// 帧循环主体；后端可注入（生产为 `RemoteFsop`，测试注入阻塞 / panic 后端）。
fn run_loop_with<R: Read>(
    reader: R,
    shared: SharedWriter,
    link: Arc<PortLink>,
    backend: Arc<dyn FsopBackend>,
) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { backend, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ToolError;

    struct FakeBackend;

    impl FsopBackend for FakeBackend {
        fn fsop(&self, _bag: &Value) -> Result<Value, ToolError> {
            Ok(json!({"text": "hello", "total_lines": 1, "truncated": false}))
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "tool-fs");
        assert_eq!(value["implements"], json!(["tool-fs"]));
        assert_eq!(value["methods"]["tool-fs"], json!(["describe", "invoke"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &FakeBackend).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn describe_call_returns_four_tools() {
        let value = handle_call("describe", &json!({}), &FakeBackend).unwrap();
        assert_eq!(value["tools"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn invoke_call_returns_ok_result() {
        let bag = json!({
            "tool": "read", "args": {"path": "a.txt"}, "workspace_root": "C:\\ws",
        });
        let value = handle_call("invoke", &bag, &FakeBackend).unwrap();
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["text"], "hello");
    }
}
