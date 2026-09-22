// `evolve-metrics` 服务进程协议面（docs/protocol.md §二）：握手 / manifest / call / 控制 / 反向调用应答 / EOF 自退出。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。
// `call` 在独立线程执行（可能等待反向调用），控制帧（probe / reload / drain）不被阻塞。

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::aggregate;
use crate::frames;
use crate::port::{AuditSource, EventSink, PortLink, RemoteAudit, SharedWriter, WriterEventSink};
use crate::record;
use crate::shadow;
use crate::state::{FileStateStore, StateStore};
use crate::sweep;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "evolve-metrics";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：v1 只允许可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 4] = ["aggregate", "sweep", "shadow", "record"];

/// 服务运行期依赖：上行事件、历史审计读面、③ 缓存。
pub struct ServiceCtx {
    pub events: Arc<dyn EventSink>,
    pub audit: Arc<dyn AuditSource>,
    pub state: Arc<dyn StateStore>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    json!({
        "v": PROTOCOL,
        "identity": IDENTITY,
        "implements": [IDENTITY],
        "methods": { IDENTITY: METHODS },
        "protocol": PROTOCOL,
        "state": STATE,
    })
}

fn error_frame(id: &Value, code: &str, message: &str) -> Value {
    json!({ "v": PROTOCOL, "id": id, "kind": "error", "ok": false, "code": code, "message": message })
}

/// 处理控制帧；`call` / `drain` / 未知种类由调用方处理。
pub fn handle_control(message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match message.get("kind").and_then(Value::as_str) {
        Some("hello") => {
            let mut response = manifest();
            response["id"] = id;
            response["kind"] = json!("manifest");
            Some(response)
        }
        Some("probe") => Some(json!({ "v": PROTOCOL, "id": id, "kind": "pong", "ok": true })),
        Some("reload") => {
            frames::log("reload");
            Some(json!({ "v": PROTOCOL, "id": id, "kind": "ack" }))
        }
        _ => None,
    }
}

/// 处理 `call`：能力类门禁 + 方法分派。
pub fn handle_call(
    method: &str,
    args: &Value,
    env: &Value,
    ctx: &ServiceCtx,
) -> Result<Value, (String, String)> {
    match method {
        "aggregate" => aggregate::run(args, env, ctx.events.as_ref(), ctx.state.as_ref()),
        "sweep" => sweep::run(args, env),
        "shadow" => shadow::run(args, env, ctx.audit.as_ref()),
        "record" => record::run(args, env),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

fn call_response(message: &Value, ctx: &ServiceCtx) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    let env = message.get("env").cloned().unwrap_or(Value::Null);
    if port != IDENTITY {
        return error_frame(&id, "unresolved_cap", &format!("unknown capability {port}"));
    }
    match handle_call(method, &args, &env, ctx) {
        Ok(value) => json!({ "v": PROTOCOL, "id": id, "kind": "result", "ok": true, "value": value }),
        Err((code, message)) => error_frame(&id, &code, &message),
    }
}

fn write_shared(writer: &SharedWriter, message: &Value) {
    if let Ok(mut guard) = writer.lock() {
        let _ = frames::write_frame(&mut *guard, message);
    }
}

fn wait_for_inflight(inflight: &Arc<(Mutex<usize>, Condvar)>, deadline_ms: u64) {
    let (lock, cvar) = &**inflight;
    let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    while *count > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, timeout) = match cvar.wait_timeout(count, remaining) {
            Ok(pair) => pair,
            Err(poisoned) => poisoned.into_inner(),
        };
        count = next;
        if timeout.timed_out() {
            break;
        }
    }
}

/// `call` 独立线程执行（可能等待反向调用），控制帧不被阻塞；在途计数用于 `drain`。
fn spawn_call(
    message: Value,
    shared: SharedWriter,
    inflight: Arc<(Mutex<usize>, Condvar)>,
    ctx: Arc<ServiceCtx>,
) {
    {
        let (lock, _) = &*inflight;
        *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) += 1;
    }
    thread::spawn(move || {
        let response = call_response(&message, &ctx);
        write_shared(&shared, &response);
        let (lock, cvar) = &*inflight;
        let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *count = count.saturating_sub(1);
        cvar.notify_all();
    });
}

/// `drain`：等在途结束（或到期限）再回 `bye`。
fn finish_drain(message: &Value, shared: &SharedWriter, inflight: &Arc<(Mutex<usize>, Condvar)>) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let deadline = message
        .get("deadline_ms")
        .and_then(Value::as_u64)
        .unwrap_or(5000);
    wait_for_inflight(inflight, deadline);
    write_shared(shared, &json!({ "v": PROTOCOL, "id": id, "kind": "bye" }));
}

/// 帧循环：反向调用应答先结算；`call` 独立线程执行；`drain` 等在途结束再 `bye`；EOF 即自退出。
pub fn run_loop<R: Read, W: Write + Send + 'static>(reader: R, writer: W) {
    let shared: SharedWriter = Arc::new(Mutex::new(Box::new(writer)));
    let link = Arc::new(PortLink::new(Arc::clone(&shared)));
    let ctx = Arc::new(ServiceCtx {
        events: Arc::new(WriterEventSink::new(Arc::clone(&shared))),
        audit: Arc::new(RemoteAudit::new(Arc::clone(&link))),
        state: Arc::new(FileStateStore::from_env()),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（生产为真实通道，测试注入捕获 sink / 静态审计 / 内存缓存）。
fn run_loop_with<R: Read>(
    mut reader: R,
    shared: SharedWriter,
    link: Arc<PortLink>,
    ctx: Arc<ServiceCtx>,
) {
    let inflight: Arc<(Mutex<usize>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
    loop {
        let message = match frames::read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(err) => {
                frames::log(&format!("bad frame: {err}"));
                break;
            }
        };
        if link.settle(&message) {
            continue;
        }
        match message.get("kind").and_then(Value::as_str).unwrap_or("") {
            "call" => spawn_call(
                message,
                Arc::clone(&shared),
                Arc::clone(&inflight),
                Arc::clone(&ctx),
            ),
            "drain" => {
                finish_drain(&message, &shared, &inflight);
                return;
            }
            _ => {
                if let Some(response) = handle_control(&message) {
                    write_shared(&shared, &response);
                }
            }
        }
    }
    link.fail_all("transport_failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::port::{CapturingEventSink, StaticAudit};
    use crate::state::MemoryStateStore;

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            events: Arc::new(CapturingEventSink::new()),
            audit: Arc::new(StaticAudit::new(Vec::new())),
            state: Arc::new(MemoryStateStore::new()),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "evolve-metrics");
        assert_eq!(value["implements"], json!(["evolve-metrics"]));
        assert_eq!(
            value["methods"]["evolve-metrics"],
            json!(["aggregate", "sweep", "shadow", "record"])
        );
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn hello_returns_manifest() {
        let response =
            handle_control(&json!({"kind":"hello","id":"h1","impl":"evolve-metrics"})).unwrap();
        assert_eq!(response["kind"], "manifest");
        assert_eq!(response["id"], "h1");
    }

    #[test]
    fn probe_returns_pong_and_reload_acks() {
        assert_eq!(handle_control(&json!({"kind":"probe","id":"p"})).unwrap()["kind"], "pong");
        assert_eq!(handle_control(&json!({"kind":"reload","id":"r"})).unwrap()["kind"], "ack");
    }

    #[test]
    fn unknown_capability_is_unresolved() {
        let response = call_response(
            &json!({"kind":"call","id":"c","port":"other","method":"aggregate","args":{}}),
            &test_ctx(),
        );
        assert_eq!(response["code"], "unresolved_cap");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &json!({}), &test_ctx()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn aggregate_call_returns_evidence_and_plan() {
        let bag = json!({
            "trace_entries": [{"kind":"trace","run":"r1","workspace_id":"w1","outcome":"refused",
                "refused_at":{"node_index":1,"code":"capability_mismatch","attributable_to":"graph"}}],
            "thresholds": {"failure_cluster_n": 1},
            "evolution": {"version":1,"trace":{"tail":null,"count":0},
                "evidence":{"tail":null,"count":0},"proposals":{"tail":null,"count":0},
                "verdicts":{"tail":null,"count":0}}
        });
        let value = handle_call("aggregate", &bag, &json!({"now": 5}), &test_ctx()).unwrap();
        assert_eq!(value["evidence"].as_array().unwrap().len(), 1);
        assert_eq!(value["evidence"][0]["class"], "failure_cluster");
        assert!(!value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn empty_trace_returns_empty_set() {
        let value = handle_call("aggregate", &json!({}), &json!({}), &test_ctx()).unwrap();
        assert!(value["evidence"].as_array().unwrap().is_empty());
        assert!(value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn record_call_returns_evidence_id_and_plan() {
        let bag = json!({
            "user_message_def": {"def": "msg-hash"},
            "workspace_id": "w1",
            "evolution": {"version":1,"trace":{"tail":null,"count":0},
                "evidence":{"tail":null,"count":0},"proposals":{"tail":null,"count":0},
                "verdicts":{"tail":null,"count":0}}
        });
        let value = handle_call("record", &bag, &json!({"run": "r9"}), &test_ctx()).unwrap();
        assert!(value["evidence_id"].as_str().unwrap().starts_with("ev-"));
        assert!(!value["$directives"].as_array().unwrap().is_empty());
    }

    #[test]
    fn record_without_user_message_is_bad_args() {
        let err = handle_call("record", &json!({"workspace_id": "w1"}), &json!({}), &test_ctx())
            .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }

    #[test]
    fn loop_handshake_probe_then_eof_exits() {
        let mut bytes =
            frames::encode_frame(&json!({"v":"1","id":"h","kind":"hello","impl":"evolve-metrics"}))
                .unwrap();
        bytes.extend_from_slice(&frames::encode_frame(&json!({"v":"1","id":"p","kind":"probe"})).unwrap());
        let sink = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Capture(Arc::clone(&sink)))));
        let link = Arc::new(PortLink::new(Arc::clone(&writer)));
        run_loop_with(std::io::Cursor::new(bytes), writer, link, Arc::new(test_ctx()));
        let frames_out = drain_frames(&sink);
        assert_eq!(frames_out[0]["kind"], "manifest");
        assert_eq!(frames_out[1]["kind"], "pong");
        assert_eq!(frames_out.len(), 2);
    }

    #[test]
    fn loop_drain_returns_bye() {
        let bytes =
            frames::encode_frame(&json!({"v":"1","id":"d","kind":"drain","deadline_ms":50})).unwrap();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Capture(Arc::clone(&sink)))));
        let link = Arc::new(PortLink::new(Arc::clone(&writer)));
        run_loop_with(std::io::Cursor::new(bytes), writer, link, Arc::new(test_ctx()));
        let frames_out = drain_frames(&sink);
        assert_eq!(frames_out[0]["kind"], "bye");
    }

    /// 测试用捕获写端：把协议出口收进内存供断言。
    #[derive(Clone)]
    struct Capture(Arc<Mutex<Vec<u8>>>);

    impl Write for Capture {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn drain_frames(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let bytes = sink.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(bytes);
        let mut out = Vec::new();
        while let Ok(Some(message)) = frames::read_frame(&mut cursor) {
            out.push(message);
        }
        out
    }
}
