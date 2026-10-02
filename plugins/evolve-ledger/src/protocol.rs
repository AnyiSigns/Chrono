// `evolve-ledger` 服务进程协议面：单一身份同时覆盖台账原语（read-chain / patch-plan /
// thresholds / hash）与指标层（aggregate / sweep / shadow / record）两组方法。
// 链原语就地调用（同一二进制），历史审计经保留身份 `host` 的 `host.audit` 读。
// 帧编解码 / 控制帧 / 线程派发 / 反向调用应答结算走 plugin-sdk。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道、不取时间：一切输入随调用 args 传入。

use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;

use plugin_sdk::{
    MultiServiceSpec, PortLink, ServiceError as SdkError, ServiceHandler, SharedWriter,
};

use crate::aggregate;
use crate::ledger::{Ledger, LocalLedger};
use crate::methods;
use crate::port::{AuditSource, EventSink, RemoteAudit, WriterEventSink};
use crate::record;
use crate::shadow;
use crate::state::{FileStateStore, StateStore};
use crate::sweep;

/// 身份名 = 台账原语能力类名。
pub const IDENTITY: &str = "evolve-ledger";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：③ 可重算（无链写；成本异常基线缓存住宿主侧 `state/plugins/evolve-ledger/`）。
pub const STATE: &str = "recomputable";

/// 反向调用等待上限：须严格大于下游（`host.audit`）声明的 `method_timeouts`。
const FORWARD_TIMEOUT_MS: u64 = 200_000;

static SPEC: MultiServiceSpec = MultiServiceSpec {
    identity: IDENTITY,
    protocol: PROTOCOL,
    state: STATE,
    capabilities: &[
        ("evolve-ledger", &["read-chain", "patch-plan", "thresholds", "hash"]),
        ("evolve-metrics", &["aggregate", "sweep", "shadow", "record"]),
    ],
};

/// 服务运行期依赖：上行事件、③ 缓存、台账提供方、历史审计读面。
pub struct ServiceCtx {
    pub events: Arc<dyn EventSink>,
    pub state: Arc<dyn StateStore>,
    pub ledger: Arc<dyn Ledger>,
    pub audit: Arc<dyn AuditSource>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    plugin_sdk::manifest(&SPEC)
}

/// 处理 `call`：能力类门禁 + 两组方法分派。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &Value,
    ctx: &ServiceCtx,
) -> Result<Value, (String, String)> {
    match method {
        "read-chain" => Ok(methods::read_chain(args)),
        "thresholds" => Ok(methods::thresholds(args)),
        "hash" => methods::hash_method(args),
        "patch-plan" => methods::patch_plan(args),
        "aggregate" => aggregate::run(
            args,
            env,
            ctx.events.as_ref(),
            ctx.state.as_ref(),
            ctx.ledger.as_ref(),
        ),
        "sweep" => sweep::run(args, env, ctx.ledger.as_ref()),
        "shadow" => shadow::run(args, env, ctx.audit.as_ref(), ctx.ledger.as_ref()),
        "record" => record::run(args, env, ctx.ledger.as_ref()),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

/// 调用处理器：反向调用通道（应答结算 / 关闭收口）。
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
    let link = Arc::new(PortLink::with_timeout(
        Arc::clone(&shared),
        IDENTITY,
        Duration::from_millis(FORWARD_TIMEOUT_MS),
    ));
    let ctx = Arc::new(ServiceCtx {
        events: Arc::new(WriterEventSink::new(Arc::clone(&shared))),
        state: Arc::new(FileStateStore::from_env()),
        ledger: Arc::new(LocalLedger::new()),
        audit: Arc::new(RemoteAudit::new(Arc::clone(&link))),
    });
    plugin_sdk::run_service(&SPEC, reader, shared, Handler { ctx, link });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::ChainWindows;
    use crate::port::{CapturingEventSink, StaticAudit};
    use crate::state::MemoryStateStore;
    use plugin_sdk::ServiceDecl;
    use serde_json::json;

    /// 假台账：四方法只需空窗口 / 空阈值，哈希恒等，无写计划。
    struct NoopLedger;

    impl Ledger for NoopLedger {
        fn read_chain(&self, _bag: &Value) -> Result<ChainWindows, crate::error::ServiceError> {
            Ok(ChainWindows::default())
        }
        fn thresholds(&self, _bag: &Value) -> Result<Value, crate::error::ServiceError> {
            Ok(json!({}))
        }
        fn hashes(&self, values: &[Value], _mode: &str) -> Result<Vec<String>, crate::error::ServiceError> {
            Ok(values.iter().map(|_| "0".repeat(64)).collect())
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
            audit: Arc::new(StaticAudit::new(Vec::new())),
        }
    }

    #[test]
    fn manifest_declares_both_capabilities() {
        let value = manifest();
        assert_eq!(value["identity"], "evolve-ledger");
        assert_eq!(value["implements"], json!(["evolve-ledger", "evolve-metrics"]));
        assert_eq!(
            value["methods"]["evolve-ledger"],
            json!(["read-chain", "patch-plan", "thresholds", "hash"])
        );
        assert_eq!(
            value["methods"]["evolve-metrics"],
            json!(["aggregate", "sweep", "shadow", "record"])
        );
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn spec_accepts_both_capabilities() {
        assert!(SPEC.accepts("evolve-ledger"));
        assert!(SPEC.accepts("evolve-metrics"));
        assert!(!SPEC.accepts("evolve-other"));
    }

    #[test]
    fn unknown_method_is_structured_error() {
        assert_eq!(
            handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err().0,
            "unknown_method"
        );
    }

    #[test]
    fn ledger_methods_dispatch_locally() {
        let value = handle_call("read-chain", &json!({"trace_entries": []}), &json!({}), &test_ctx()).unwrap();
        assert!(value["trace"].as_array().unwrap().is_empty());
        assert_eq!(value["body"], Value::Null);
    }

    #[test]
    fn metrics_methods_dispatch_locally() {
        let ctx = test_ctx();
        let aggregated = handle_call("aggregate", &json!({}), &json!({}), &ctx).unwrap();
        assert!(aggregated["evidence"].as_array().unwrap().is_empty());
        let swept = handle_call("sweep", &json!({}), &json!({}), &ctx).unwrap();
        assert_eq!(swept["swept"], 0);
        let shadowed = handle_call("shadow", &json!({"audit": []}), &json!({}), &ctx).unwrap();
        assert_eq!(shadowed["status"], "unverified");
        let err = handle_call("record", &json!({"workspace_id": "w1"}), &json!({}), &ctx).unwrap_err();
        assert_eq!(err.0, "bad_args");
    }
}
