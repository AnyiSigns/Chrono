// `evolve-evidence` 服务进程协议面：方法分派（aggregate / record）；
// 帧编解码 / 控制帧 / 线程派发 / 反向调用应答结算走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。

use std::io::{Read, Write};
use std::sync::Arc;

use serde_json::Value;

use plugin_sdk::{
    PortLink, ServiceError as SdkError, ServiceHandler, ServiceSpec, SharedWriter,
};

use crate::aggregate;
use crate::ledger::{Ledger, RemoteLedger};
use crate::port::{EventSink, WriterEventSink};
use crate::record;
use crate::state::{FileStateStore, StateStore};

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "evolve-evidence";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（基线缓存）。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["aggregate", "record"];

static SPEC: ServiceSpec = ServiceSpec {
    identity: IDENTITY,
    capability: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    methods: &METHODS,
};

/// 服务运行期依赖：上行事件、③ 缓存、台账提供方。
pub struct ServiceCtx {
    pub events: Arc<dyn EventSink>,
    pub state: Arc<dyn StateStore>,
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
        "aggregate" => aggregate::run(args, env, ctx.events.as_ref(), ctx.state.as_ref(), ctx.ledger.as_ref()),
        "record" => record::run(args, env, ctx.ledger.as_ref()),
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
    let link = Arc::new(PortLink::new(Arc::clone(&shared), "evolve-evidence"));
    let ctx = Arc::new(ServiceCtx {
        events: Arc::new(WriterEventSink::new(Arc::clone(&shared))),
        state: Arc::new(FileStateStore::from_env()),
        ledger: Arc::new(RemoteLedger::new(Arc::clone(&link))),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（测试注入捕获 sink / 内存缓存 / 假台账）。
fn run_loop_with<R: Read>(reader: R, shared: SharedWriter, link: Arc<PortLink>, ctx: Arc<ServiceCtx>) {
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ChainWindows;
    use crate::port::CapturingEventSink;
    use crate::state::MemoryStateStore;
    use serde_json::json;

    /// 假台账：aggregate 空轨迹只需 `hashes` 恒等，`read_chain` 回空窗口。
    struct NoopLedger;

    impl Ledger for NoopLedger {
        fn read_chain(&self, _bag: &Value) -> Result<ChainWindows, crate::error::ServiceError> {
            Ok(ChainWindows::default())
        }
        fn thresholds(&self, _bag: &Value) -> Result<Value, crate::error::ServiceError> {
            Ok(json!({}))
        }
        fn hashes(&self, values: &[Value], _mode: &str) -> Result<Vec<String>, crate::error::ServiceError> {
            Ok(values.iter().map(|_| "0".repeat(16)).collect())
        }
        fn patch_plan(&self, _request: &Value) -> Result<Value, crate::error::ServiceError> {
            Ok(json!({"$directives": []}))
        }
    }

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            events: Arc::new(CapturingEventSink::new()),
            state: Arc::new(MemoryStateStore::new()),
            ledger: Arc::new(NoopLedger),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "evolve-evidence");
        assert_eq!(value["implements"], json!(["evolve-evidence"]));
        assert_eq!(value["methods"]["evolve-evidence"], json!(["aggregate", "record"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn empty_aggregate_returns_empty_set() {
        let value = handle_call("aggregate", &json!({}), &json!({}), &test_ctx()).unwrap();
        assert!(value["evidence"].as_array().unwrap().is_empty());
        assert!(value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn record_without_user_message_is_bad_args() {
        let err = handle_call("record", &json!({"workspace_id": "w1"}), &json!({}), &test_ctx())
            .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }
}
