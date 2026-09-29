// `query-plan` 服务进程协议面：方法分派（plan）；帧编解码 / 控制帧 / 线程派发 /
// 反向调用应答结算走 plugin-sdk。stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：
// 所需世界数据全由调用方随 args 传入；反向调用 model 一个 pin。

use std::io::{Read, Write};
use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::{PortLink, ServiceError, ServiceHandler, ServiceSpec, SharedWriter};

use crate::plan;
use crate::port::{ModelPort, Ports, RemoteModel};

/// 身份名。
pub const IDENTITY: &str = "query-plan";
/// 能力类名（= 身份名）。
pub const CAPABILITY: &str = "query-plan";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（无本地状态）。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 1] = ["plan"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: CAPABILITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务运行期依赖：model 反向调用面。
pub struct ServiceCtx {
    pub model: Arc<dyn ModelPort>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：能力类门禁 + 方法分派。
pub fn handle_call(
    method: &str,
    args: &Value,
    _env: &Value,
    ctx: &ServiceCtx,
) -> Result<Value, (String, String)> {
    match method {
        "plan" => {
            let ports = Ports {
                model: ctx.model.as_ref(),
            };
            Ok(plan::run(args, &ports))
        }
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

/// 调用处理器：领域依赖 + 反向调用通道（应答结算 / 关闭收口）。
struct Handler {
    ctx: Arc<ServiceCtx>,
    link: Arc<PortLink>,
}

impl ServiceHandler for Handler {
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError> {
        handle_call(method, args, env, &self.ctx).map_err(ServiceError::from)
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
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "query-plan"));
    let ctx = Arc::new(ServiceCtx {
        model: Arc::new(RemoteModel::new(Arc::clone(&link))),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（生产为真实通道，测试注入假实现）。
fn run_loop_with<R: Read>(reader: R, shared: SharedWriter, link: Arc<PortLink>, ctx: Arc<ServiceCtx>) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::FakeModel;
    use serde_json::json;

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            model: Arc::new(FakeModel::new("[]")),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "query-plan");
        assert_eq!(value["implements"], json!(["query-plan"]));
        assert_eq!(value["methods"]["query-plan"], json!(["plan"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn plan_call_returns_query_set() {
        let value = handle_call("plan", &json!({"query": "note"}), &json!({}), &test_ctx()).unwrap();
        assert_eq!(value["query"], "note");
        assert_eq!(value["queries"], json!(["note"]));
    }
}
