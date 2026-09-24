// `memory-retrieval` 服务进程协议面：握手 / manifest / call / 控制 / 反向调用应答 / EOF 自退出。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 bag 传入。
// `call` 在独立线程执行（可能等待反向调用），控制帧（probe / reload / drain）不被阻塞。

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::frames;
use crate::port::{
    CurrentCallIdGuard, EmbeddingPort, MemoryPort, ModelPort, PortLink, Ports, RemoteEmbedding,
    RemoteMemory, RemoteModel, SharedWriter,
};
use crate::retrieve;
use crate::state::{FileStateStore, StateStore};

/// 身份名。
pub const IDENTITY: &str = "memory-retrieval";
/// 能力类名（= 方法声明的能力类）。
pub const CAPABILITY: &str = "retrieval";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：v1 只允许可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 1] = ["search"];

/// 服务运行期依赖：三个反向调用面 + ③ 查询向量缓存。
pub struct ServiceCtx {
    pub embedding: Arc<dyn EmbeddingPort>,
    pub memory: Arc<dyn MemoryPort>,
    pub model: Arc<dyn ModelPort>,
    pub state: Arc<dyn StateStore>,
}

/// 服务自述（与 `plugin.json` 一致）。
pub fn manifest() -> Value {
    json!({
        "v": PROTOCOL,
        "identity": IDENTITY,
        "implements": [CAPABILITY],
        "methods": { CAPABILITY: METHODS },
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
        "search" => {
            let ports = Ports {
                embedding: ctx.embedding.as_ref(),
                memory: ctx.memory.as_ref(),
                model: ctx.model.as_ref(),
            };
            retrieve::run(args, env, &ports, ctx.state.as_ref())
        }
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

fn call_response(message: &Value, ctx: &ServiceCtx) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    // 每 call 独立线程：记下本线程正在处理的正向帧 id，供反向调用回带 `call_id`；
    // 守卫在返回 / panic 时清空，避免线程复用时残留。
    let _call_id_guard = CurrentCallIdGuard::set(id.as_str().map(str::to_string));
    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    let env = message.get("env").cloned().unwrap_or(Value::Null);
    if port != CAPABILITY {
        return error_frame(&id, "unresolved_cap", &format!("unknown capability {port}"));
    }
    match handle_call(method, &args, &env, ctx) {
        Ok(value) => {
            json!({ "v": PROTOCOL, "id": id, "kind": "result", "ok": true, "value": value })
        }
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

/// 在途调用上限：超过即回结构化错误，避免无界 `thread::spawn` 耗尽资源。
const MAX_INFLIGHT: usize = 128;

/// 在途调用计数守卫：构造时自增，`Drop` 时持锁自减并唤醒 `drain`。
/// 必须在 `spawn` 前构造并 move 进线程——否则子线程可能在自增前完成，计数不归零。
struct InflightGuard {
    inflight: Arc<(Mutex<usize>, Condvar)>,
}

impl InflightGuard {
    /// 未达上限时自增并返回守卫；已达上限返回 `None`（调用方回 `overloaded`，不 spawn）。
    fn try_acquire(inflight: Arc<(Mutex<usize>, Condvar)>) -> Option<Self> {
        {
            let (lock, _) = &*inflight;
            let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if *count >= MAX_INFLIGHT {
                return None;
            }
            *count += 1;
        }
        Some(Self { inflight })
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        let (lock, cvar) = &*self.inflight;
        let mut count = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        *count = count.saturating_sub(1);
        cvar.notify_all();
    }
}

/// `call` 独立线程执行（可能等待反向调用），控制帧不被阻塞；在途计数用于 `drain`。
fn spawn_call(
    message: Value,
    shared: SharedWriter,
    inflight: Arc<(Mutex<usize>, Condvar)>,
    ctx: Arc<ServiceCtx>,
) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(guard) = InflightGuard::try_acquire(Arc::clone(&inflight)) else {
        frames::log("call rejected: inflight limit reached");
        write_shared(&shared, &error_frame(&id, "overloaded", "inflight limit reached"));
        return;
    };
    let fallback = Arc::clone(&shared);
    if let Err(err) = thread::Builder::new().spawn(move || {
        let response = call_response(&message, &ctx);
        write_shared(&shared, &response);
        // guard 随闭包结束（或 spawn 失败）而 Drop：计数必归零。
        drop(guard);
    }) {
        frames::log(&format!("spawn call failed: {err}"));
        write_shared(&fallback, &error_frame(&id, "spawn_failed", &err.to_string()));
    }
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
        embedding: Arc::new(RemoteEmbedding::new(Arc::clone(&link))),
        memory: Arc::new(RemoteMemory::new(Arc::clone(&link))),
        model: Arc::new(RemoteModel::new(Arc::clone(&link))),
        state: Arc::new(FileStateStore::from_env()),
    });
    run_loop_with(reader, shared, link, ctx);
}

/// 帧循环主体；依赖可注入（生产为真实通道，测试注入假实现 / 内存缓存）。
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
    use crate::port::{FakeEmbedding, FakeMemory, FakeModel};
    use crate::state::MemoryStateStore;
    use std::collections::BTreeMap;

    fn test_ctx() -> ServiceCtx {
        ServiceCtx {
            embedding: Arc::new(FakeEmbedding::new(4)),
            memory: Arc::new(FakeMemory::new(Vec::new(), BTreeMap::new())),
            model: Arc::new(FakeModel::new("[]")),
            state: Arc::new(MemoryStateStore::new()),
        }
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "memory-retrieval");
        assert_eq!(value["implements"], json!(["retrieval"]));
        assert_eq!(value["methods"]["retrieval"], json!(["search"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn hello_returns_manifest() {
        let response =
            handle_control(&json!({"kind":"hello","id":"h1","impl":"memory-retrieval"})).unwrap();
        assert_eq!(response["kind"], "manifest");
        assert_eq!(response["id"], "h1");
    }

    #[test]
    fn probe_returns_pong_and_reload_acks() {
        assert_eq!(
            handle_control(&json!({"kind":"probe","id":"p"})).unwrap()["kind"],
            "pong"
        );
        assert_eq!(
            handle_control(&json!({"kind":"reload","id":"r"})).unwrap()["kind"],
            "ack"
        );
    }

    #[test]
    fn unknown_capability_is_unresolved() {
        let response = call_response(
            &json!({"kind":"call","id":"c","port":"other","method":"search","args":{}}),
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
    fn call_response_clears_current_call_id_after_return() {
        let _ = call_response(
            &json!({"kind":"call","id":"c-9","port":"retrieval","method":"search","args":{}}),
            &test_ctx(),
        );
        // 处理期由守卫记录、返回后清空，避免线程复用时残留。
        assert_eq!(crate::port::current_call_id(), None);
    }

    #[test]
    fn search_call_returns_empty_recall() {
        let value =
            handle_call("search", &json!({"query": "note"}), &json!({}), &test_ctx()).unwrap();
        assert_eq!(value["kind"], "search");
        assert!(value["recall"].as_array().unwrap().is_empty());
    }

    #[test]
    fn loop_handshake_probe_then_eof_exits() {
        let mut bytes = frames::encode_frame(
            &json!({"v":"1","id":"h","kind":"hello","impl":"memory-retrieval"}),
        )
        .unwrap();
        bytes.extend_from_slice(
            &frames::encode_frame(&json!({"v":"1","id":"p","kind":"probe"})).unwrap(),
        );
        let sink = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Capture(Arc::clone(&sink)))));
        let link = Arc::new(PortLink::new(Arc::clone(&writer)));
        run_loop_with(
            std::io::Cursor::new(bytes),
            writer,
            link,
            Arc::new(test_ctx()),
        );
        let frames_out = drain_frames(&sink);
        assert_eq!(frames_out[0]["kind"], "manifest");
        assert_eq!(frames_out[1]["kind"], "pong");
        assert_eq!(frames_out.len(), 2);
    }

    #[test]
    fn loop_drain_returns_bye() {
        let bytes =
            frames::encode_frame(&json!({"v":"1","id":"d","kind":"drain","deadline_ms":50}))
                .unwrap();
        let sink = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedWriter = Arc::new(Mutex::new(Box::new(Capture(Arc::clone(&sink)))));
        let link = Arc::new(PortLink::new(Arc::clone(&writer)));
        run_loop_with(
            std::io::Cursor::new(bytes),
            writer,
            link,
            Arc::new(test_ctx()),
        );
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

    #[test]
    fn inflight_guard_bounds_concurrent_calls() {
        let inflight: Arc<(Mutex<usize>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
        let mut guards = Vec::new();
        for _ in 0..MAX_INFLIGHT {
            guards.push(InflightGuard::try_acquire(Arc::clone(&inflight)).expect("under limit"));
        }
        assert!(InflightGuard::try_acquire(Arc::clone(&inflight)).is_none());
        drop(guards.pop());
        assert!(InflightGuard::try_acquire(Arc::clone(&inflight)).is_some());
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
