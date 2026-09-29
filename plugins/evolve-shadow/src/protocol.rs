// `evolve-shadow` 服务进程协议面：方法分派（shadow）；
// 帧编解码 / 控制帧 / 线程派发 / 反向调用应答结算走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。

use std::io::{Read, Write};
use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::{
    PortLink, ServiceError as SdkError, ServiceHandler, ServiceSpec, SharedWriter,
};

use crate::ledger::{Ledger, RemoteLedger};
use crate::port::{AuditSource, RemoteAudit};
use crate::shadow;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "evolve-shadow";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（本插件无自有状态）。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 1] = ["shadow"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务运行期依赖：历史审计读面 + 台账提供方。
pub struct ServiceCtx {
    pub audit: Arc<dyn AuditSource>,
    pub ledger: Arc<dyn Ledger>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：能力类门禁 + 方法分派。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &Value,
    ctx: &ServiceCtx,
) -> Result<Value, (String, String)> {
    match method {
        "shadow" => shadow::run(args, env, ctx.audit.as_ref(), ctx.ledger.as_ref()),
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
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, SdkError> {
        handle_call(method, args, env, &self.ctx).map_err(SdkError::from)
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
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "evolve-shadow"));
    let ctx = Arc::new(ServiceCtx {
        audit: Arc::new(RemoteAudit::new(Arc::clone(&link))),
        ledger: Arc::new(RemoteLedger::new(Arc::clone(&link))),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（测试注入静态审计 / 假台账）。
fn run_loop_with<R: Read>(reader: R, shared: SharedWriter, link: Arc<PortLink>, ctx: Arc<ServiceCtx>) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ChainWindows;
    use crate::port::StaticAudit;
    use serde_json::json;

    struct NoopLedger;

    impl Ledger for NoopLedger {
        fn read_chain(&self, _bag: &Value) -> Result<ChainWindows, crate::error::ServiceError> {
            Ok(ChainWindows::default())
        }
        fn thresholds(&self, _bag: &Value) -> Result<Value, crate::error::ServiceError> {
            Ok(json!({}))
        }
        fn hashes(&self, _values: &[Value], _mode: &str) -> Result<Vec<String>, crate::error::ServiceError> {
            Ok(vec!["0".repeat(64)])
        }
        fn patch_plan(&self, _request: &Value) -> Result<Value, crate::error::ServiceError> {
            Ok(json!({"$directives": [{"kind": "write"}]}))
        }
    }

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            audit: Arc::new(StaticAudit::new(Vec::new())),
            ledger: Arc::new(NoopLedger),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "evolve-shadow");
        assert_eq!(value["implements"], json!(["evolve-shadow"]));
        assert_eq!(value["methods"]["evolve-shadow"], json!(["shadow"]));
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        assert_eq!(handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err().0, "unknown_method");
    }

    #[test]
    fn shadow_without_expected_is_unverified() {
        let value = handle_call("shadow", &json!({"audit": []}), &json!({}), &test_ctx()).unwrap();
        assert_eq!(value["status"], "unverified");
        assert!(!value["$directives"].as_array().unwrap().is_empty());
    }
}
