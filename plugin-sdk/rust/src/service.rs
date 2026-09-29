// 服务协议壳：manifest 派生、帧循环、能力调用派发、在途计数与 drain 收口。
// 插件只写方法实现（`ServiceHandler::call`）与反向调用结算（`ServiceHandler::intercept`），
// 帧编解码 / 控制帧 / 线程派发 / 错误信封全由本模块吸收。

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::wire::{read_frame, write_frame};

/// 协议出口：宿主 `call` 的应答、反向 `port.call`、上行 `event` 共用同一写端。
pub type SharedWriter = Arc<Mutex<Box<dyn Write + Send>>>;

/// 把任意写端包成共享协议出口。
pub fn shared_writer<W: Write + Send + 'static>(writer: W) -> SharedWriter {
    Arc::new(Mutex::new(Box::new(writer)))
}

/// 从 `CHRONO_PLUGIN_MANY_NEEDS` 解析宿主注入的 `many` 成员表（stdio 形态）：能力类 → 成员身份名。
/// 缺失 / 坏 JSON / 形不合回落 `None`（不抛）；键与成员均按码元序（`BTreeMap` / 排序），
/// 使「无匹配 / 歧义」的选择规则确定性可复现。inproc / worker 形态没有该 env，故仅 stdio 需要。
pub fn many_needs_from_env() -> Option<std::collections::BTreeMap<String, Vec<String>>> {
    let raw = std::env::var("CHRONO_PLUGIN_MANY_NEEDS").ok()?;
    parse_many_needs(&raw)
}

/// 解析 `many` 成员表 JSON 文本（与 `many_needs_from_env` 同口径，便于确定性单测）。
fn parse_many_needs(raw: &str) -> Option<std::collections::BTreeMap<String, Vec<String>>> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let object = parsed.as_object()?;
    let mut out = std::collections::BTreeMap::new();
    for (cap, value) in object {
        let array = value.as_array()?;
        let mut members = Vec::with_capacity(array.len());
        for item in array {
            members.push(item.as_str()?.to_string());
        }
        members.sort();
        out.insert(cap.clone(), members);
    }
    Some(out)
}

/// 结构化服务错误：错误码 + 人读消息；错误码与协议 / 内核词表同源，由插件给出。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceError {
    pub code: String,
    pub message: String,
}

impl ServiceError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<(String, String)> for ServiceError {
    fn from((code, message): (String, String)) -> Self {
        Self { code, message }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ServiceError {}

/// 调用帧的 `env`（宿主填写，机械）。服务不落世界、不发事件时仅留存备用。
#[derive(Clone, Debug, Default)]
pub struct CallEnv {
    pub run: Option<String>,
    pub thread: Option<String>,
    pub now: f64,
}

impl CallEnv {
    /// 从帧内 `env` 字段解析；缺失或形态不合回落缺省（全空 / `now = 0`）。
    pub fn parse(raw: Option<&Value>) -> Self {
        match raw {
            Some(value) => Self::parse_value(value),
            None => Self::default(),
        }
    }

    /// 从 `env` 值解析；非对象回落缺省。
    pub fn parse_value(raw: &Value) -> Self {
        let Some(object) = raw.as_object() else {
            return Self::default();
        };
        Self {
            run: object.get("run").and_then(Value::as_str).map(str::to_string),
            thread: object.get("thread").and_then(Value::as_str).map(str::to_string),
            now: object.get("now").and_then(Value::as_f64).unwrap_or(0.0),
        }
    }
}

/// 服务自述口径（与同包 `plugin.json` 一致）。
pub struct ServiceSpec {
    /// 身份名。
    pub identity: &'static str,
    /// 本服务声明的能力类名（类名 = 身份名的插件直接填身份名）。
    pub capability: &'static str,
    /// 协议版本。
    pub protocol: &'static str,
    /// 状态档（`recomputable` / `durable`）。
    pub state: &'static str,
    /// 能力类声明的方法集。
    pub methods: &'static [&'static str],
}

/// 由服务口径构造 `manifest` 帧体（不含 `id` / `kind`）。
pub fn manifest(spec: &ServiceSpec) -> Value {
    let mut methods = Map::new();
    methods.insert(spec.capability.to_string(), json!(spec.methods));
    json!({
        "v": spec.protocol,
        "identity": spec.identity,
        "implements": [spec.capability],
        "methods": Value::Object(methods),
        "protocol": spec.protocol,
        "state": spec.state,
    })
}

/// 插件的调用面：方法分派 + 可选的帧拦截与关闭钩子。
pub trait ServiceHandler: Send + Sync + 'static {
    /// 处理一次 `call`（`port` 已过能力类门禁）；错误经 `ServiceError` 带码上抛。
    fn call(&self, method: &str, args: &Value, env: &Value) -> Result<Value, ServiceError>;

    /// 帧进入控制 / 调用派发前的拦截（如反向调用应答结算）；返回 `true` 表示已消费。
    fn intercept(&self, _frame: &Value) -> bool {
        false
    }

    /// 通道关闭（stdin EOF / 坏帧）时的清理（如未结算的反向调用全部作数据失败）。
    fn on_close(&self) {}
}

thread_local! {
    /// 当前线程正在处理的正向 `call` 帧 id；反向 `port.call` 据此回带可选 `call_id`。
    static CURRENT_CALL_ID: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
}

/// 记录当前线程正在处理的正向 `call` 帧 id（无 id / 非字符串时传 `None`）。
pub fn set_current_call_id(id: Option<String>) {
    CURRENT_CALL_ID.with(|slot| *slot.borrow_mut() = id);
}

/// 读当前线程正在处理的 `call` 帧 id（反向调用发送点使用）。
pub fn current_call_id() -> Option<String> {
    CURRENT_CALL_ID.with(|slot| slot.borrow().clone())
}

/// 当前调用 id 的作用域守卫：构造时记录、`Drop` 时清空。
/// 正向帧处理提前返回或 panic 时也不会把 id 残留到线程后续复用（防止反向调用串台）。
pub struct CurrentCallIdGuard;

impl CurrentCallIdGuard {
    /// 记录本线程正在处理的正向帧 id，并在守卫 Drop 时清空。
    pub fn set(id: Option<String>) -> Self {
        set_current_call_id(id);
        Self
    }
}

impl Drop for CurrentCallIdGuard {
    fn drop(&mut self) {
        set_current_call_id(None);
    }
}

fn error_frame(spec: &ServiceSpec, id: &Value, code: &str, message: &str) -> Value {
    json!({ "v": spec.protocol, "id": id, "kind": "error", "ok": false, "code": code, "message": message })
}

fn write_shared(writer: &SharedWriter, message: &Value) {
    if let Ok(mut guard) = writer.lock() {
        let _ = write_frame(&mut *guard, message);
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

fn call_response<H: ServiceHandler>(spec: &ServiceSpec, message: &Value, handler: &H) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    // 每 call 独立线程：记下本线程正在处理的正向帧 id，供反向调用回带 `call_id`；
    // 守卫在返回 / panic 时清空，避免线程复用时残留。
    let _call_id_guard = CurrentCallIdGuard::set(id.as_str().map(str::to_string));
    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    let env = message.get("env").cloned().unwrap_or(Value::Null);
    if port != spec.capability {
        return error_frame(spec, &id, "unresolved_cap", &format!("unknown capability {port}"));
    }
    match handler.call(method, &args, &env) {
        Ok(value) => json!({ "v": spec.protocol, "id": id, "kind": "result", "ok": true, "value": value }),
        Err(error) => error_frame(spec, &id, &error.code, &error.message),
    }
}

fn spawn_call<H: ServiceHandler>(
    spec: &'static ServiceSpec,
    shared: &SharedWriter,
    inflight: &Arc<(Mutex<usize>, Condvar)>,
    handler: &Arc<H>,
    message: Value,
) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let Some(guard) = InflightGuard::try_acquire(Arc::clone(inflight)) else {
        crate::wire::log(spec.identity, "call rejected: inflight limit reached");
        write_shared(shared, &error_frame(spec, &id, "overloaded", "inflight limit reached"));
        return;
    };
    let shared = Arc::clone(shared);
    let fallback = Arc::clone(&shared);
    let handler = Arc::clone(handler);
    if let Err(err) = thread::Builder::new().spawn(move || {
        let response = call_response(spec, &message, handler.as_ref());
        write_shared(&shared, &response);
        // guard 随闭包结束（或 spawn 失败）而 Drop：计数必归零。
        drop(guard);
    }) {
        crate::wire::log(spec.identity, &format!("spawn call failed: {err}"));
        write_shared(&fallback, &error_frame(spec, &id, "spawn_failed", &err.to_string()));
    }
}

fn handle_control(spec: &ServiceSpec, message: &Value) -> Option<Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match message.get("kind").and_then(Value::as_str) {
        Some("hello") => {
            let mut response = manifest(spec);
            response["id"] = id;
            response["kind"] = json!("manifest");
            Some(response)
        }
        Some("probe") => Some(json!({ "v": spec.protocol, "id": id, "kind": "pong", "ok": true })),
        Some("reload") => {
            crate::wire::log(spec.identity, "reload");
            Some(json!({ "v": spec.protocol, "id": id, "kind": "ack" }))
        }
        _ => None,
    }
}

fn finish_drain(spec: &ServiceSpec, shared: &SharedWriter, inflight: &Arc<(Mutex<usize>, Condvar)>, message: &Value) {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let deadline = message.get("deadline_ms").and_then(Value::as_u64).unwrap_or(5000);
    wait_for_inflight(inflight, deadline);
    write_shared(shared, &json!({ "v": spec.protocol, "id": id, "kind": "bye" }));
}

/// 服务帧循环：拦截帧先结算；`call` 独立线程执行；`drain` 等在途结束再 `bye`；EOF 即自退出。
/// 循环结束（EOF / 坏帧）时调 `handler.on_close()` 收口（`drain` 已自行收口，不重复）。
pub fn run_service<R, H>(spec: &'static ServiceSpec, mut reader: R, shared: SharedWriter, handler: H)
where
    R: Read,
    H: ServiceHandler,
{
    let handler = Arc::new(handler);
    let inflight: Arc<(Mutex<usize>, Condvar)> = Arc::new((Mutex::new(0), Condvar::new()));
    loop {
        let message = match read_frame(&mut reader) {
            Ok(Some(message)) => message,
            Ok(None) => break,
            Err(err) => {
                crate::wire::log(spec.identity, &format!("bad frame: {err}"));
                break;
            }
        };
        if handler.intercept(&message) {
            continue;
        }
        match message.get("kind").and_then(Value::as_str).unwrap_or("") {
            "call" => spawn_call(spec, &shared, &inflight, &handler, message),
            "drain" => {
                finish_drain(spec, &shared, &inflight, &message);
                return;
            }
            _ => {
                if let Some(response) = handle_control(spec, &message) {
                    write_shared(&shared, &response);
                }
            }
        }
    }
    handler.on_close();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::encode_frame;

    struct Echo;

    impl ServiceHandler for Echo {
        fn call(&self, method: &str, args: &Value, _env: &Value) -> Result<Value, ServiceError> {
            match method {
                "echo" => Ok(args.clone()),
                "fail" => Err(ServiceError::new("boom", "deliberate")),
                other => Err(ServiceError::new("unknown_method", format!("unknown method {other}"))),
            }
        }
    }

    static SPEC: ServiceSpec = ServiceSpec {
        identity: "toy",
        capability: "toy",
        protocol: "1",
        state: "recomputable",
        methods: &["echo", "fail"],
    };

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

    fn capture() -> (SharedWriter, Arc<Mutex<Vec<u8>>>) {
        let sink = Arc::new(Mutex::new(Vec::new()));
        (shared_writer(Capture(Arc::clone(&sink))), sink)
    }

    fn drain_frames(sink: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        let bytes = sink.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(bytes);
        let mut out = Vec::new();
        while let Some(message) = read_frame(&mut cursor).unwrap() {
            out.push(message);
        }
        out
    }

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest(&SPEC);
        assert_eq!(value["identity"], "toy");
        assert_eq!(value["implements"], json!(["toy"]));
        assert_eq!(value["methods"]["toy"], json!(["echo", "fail"]));
        assert_eq!(value["state"], "recomputable");
        assert_eq!(value["protocol"], "1");
    }

    #[test]
    fn hello_probe_reload_are_answered() {
        assert_eq!(handle_control(&SPEC, &json!({"kind":"hello","id":"h"})).unwrap()["kind"], "manifest");
        assert_eq!(handle_control(&SPEC, &json!({"kind":"probe","id":"p"})).unwrap()["kind"], "pong");
        assert_eq!(handle_control(&SPEC, &json!({"kind":"reload","id":"r"})).unwrap()["kind"], "ack");
    }

    #[test]
    fn parse_many_needs_sorts_members_and_rejects_bad_shape() {
        let parsed = parse_many_needs(r#"{"embedding-provider":["embedding-local","embedding-fixture"]}"#)
            .expect("valid many needs parses");
        assert_eq!(
            parsed.get("embedding-provider"),
            Some(&vec!["embedding-fixture".to_string(), "embedding-local".to_string()])
        );
        assert!(parse_many_needs("not json").is_none());
        assert!(parse_many_needs(r#"{"cap":[1]}"#).is_none());
        assert!(parse_many_needs(r#"{"cap":"nope"}"#).is_none());
    }

    #[test]
    fn call_returns_result_and_structured_error() {
        let result = call_response(
            &SPEC,
            &json!({"v":"1","id":"c","kind":"call","port":"toy","method":"echo","args":{"n":1}}),
            &Echo,
        );
        assert_eq!(result["kind"], "result");
        assert_eq!(result["value"]["n"], 1);

        let error = call_response(
            &SPEC,
            &json!({"v":"1","id":"c","kind":"call","port":"toy","method":"fail","args":{}}),
            &Echo,
        );
        assert_eq!(error["kind"], "error");
        assert_eq!(error["code"], "boom");
    }

    #[test]
    fn unknown_capability_and_method_are_structured() {
        let unresolved = call_response(
            &SPEC,
            &json!({"v":"1","id":"c","kind":"call","port":"other","method":"echo","args":{}}),
            &Echo,
        );
        assert_eq!(unresolved["code"], "unresolved_cap");

        let unknown = call_response(
            &SPEC,
            &json!({"v":"1","id":"c","kind":"call","port":"toy","method":"nope","args":{}}),
            &Echo,
        );
        assert_eq!(unknown["code"], "unknown_method");
    }

    #[test]
    fn loop_handshake_probe_then_eof_exits() {
        let mut bytes = encode_frame(&json!({"v":"1","id":"h","kind":"hello","impl":"toy"})).unwrap();
        bytes.extend_from_slice(&encode_frame(&json!({"v":"1","id":"p","kind":"probe"})).unwrap());
        let (writer, sink) = capture();
        run_service(&SPEC, std::io::Cursor::new(bytes), writer, Echo);
        let frames = drain_frames(&sink);
        assert_eq!(frames[0]["kind"], "manifest");
        assert_eq!(frames[1]["kind"], "pong");
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn drain_returns_bye() {
        let bytes = encode_frame(&json!({"v":"1","id":"d","kind":"drain","deadline_ms":50})).unwrap();
        let (writer, sink) = capture();
        run_service(&SPEC, std::io::Cursor::new(bytes), writer, Echo);
        let frames = drain_frames(&sink);
        assert_eq!(frames[0]["kind"], "bye");
        assert_eq!(frames[0]["id"], "d");
    }

    /// 阻塞处理器：进入后发信号，等测试释放才回结果。
    struct BlockingHandler {
        started: std::sync::mpsc::Sender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }

    impl ServiceHandler for BlockingHandler {
        fn call(&self, _method: &str, _args: &Value, _env: &Value) -> Result<Value, ServiceError> {
            let _ = self.started.send(());
            let (lock, cvar) = &*self.release;
            let mut released = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            while !*released {
                released = match cvar.wait(released) {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
            }
            Ok(json!({"done": true}))
        }
    }

    #[test]
    fn drain_waits_for_inflight_call_before_bye() {
        let mut input = encode_frame(&json!({
            "v":"1","id":"c1","kind":"call","port":"toy","method":"echo","args":{},
        }))
        .unwrap();
        input.extend_from_slice(&encode_frame(&json!({"v":"1","id":"d1","kind":"drain","deadline_ms":5000})).unwrap());

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let handler = BlockingHandler { started: started_tx, release: Arc::clone(&release) };
        let (writer, sink) = capture();
        let handle = thread::spawn(move || {
            run_service(&SPEC, std::io::Cursor::new(input), writer, handler);
        });
        started_rx.recv_timeout(Duration::from_secs(5)).expect("blocking handler not entered");
        {
            let (lock, cvar) = &*release;
            *lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = true;
            cvar.notify_all();
        }
        handle.join().unwrap();
        let frames = drain_frames(&sink);
        let result_index = frames.iter().position(|frame| frame["kind"] == "result").expect("result missing");
        let bye_index = frames.iter().position(|frame| frame["kind"] == "bye").expect("bye missing");
        assert!(result_index < bye_index, "bye 必须先等在途 call 结算：{frames:?}");
    }

    /// panic 处理器：在途线程 unwind 时守卫 Drop，`drain` 仍能结算并回 `bye`（不悬挂）。
    struct PanickingHandler;

    impl ServiceHandler for PanickingHandler {
        fn call(&self, _method: &str, _args: &Value, _env: &Value) -> Result<Value, ServiceError> {
            panic!("handler boom");
        }
    }

    #[test]
    fn panicking_call_releases_inflight_for_drain() {
        let mut input = encode_frame(&json!({
            "v":"1","id":"c1","kind":"call","port":"toy","method":"echo","args":{},
        }))
        .unwrap();
        input.extend_from_slice(&encode_frame(&json!({"v":"1","id":"d1","kind":"drain","deadline_ms":2000})).unwrap());
        let (writer, sink) = capture();
        let start = Instant::now();
        let handle = thread::spawn(move || {
            run_service(&SPEC, std::io::Cursor::new(input), writer, PanickingHandler);
        });
        handle.join().unwrap();
        let elapsed = start.elapsed();
        let frames = drain_frames(&sink);
        assert!(frames.iter().any(|frame| frame["kind"] == "bye"), "drain 应回 bye：{frames:?}");
        assert!(elapsed < Duration::from_millis(500), "panic 后计数应已归零（耗时 {elapsed:?}）");
    }

    #[test]
    fn intercept_consumes_frames_and_on_close_runs() {
        struct Interceptor {
            closed: Arc<Mutex<bool>>,
        }
        impl ServiceHandler for Interceptor {
            fn call(&self, _method: &str, _args: &Value, _env: &Value) -> Result<Value, ServiceError> {
                Ok(Value::Null)
            }
            fn intercept(&self, frame: &Value) -> bool {
                frame.get("kind").and_then(Value::as_str) == Some("port.result")
            }
            fn on_close(&self) {
                *self.closed.lock().unwrap() = true;
            }
        }
        let bytes = encode_frame(&json!({"v":"1","id":"x","kind":"port.result","value":1})).unwrap();
        let (writer, sink) = capture();
        let closed = Arc::new(Mutex::new(false));
        run_service(&SPEC, std::io::Cursor::new(bytes), writer, Interceptor { closed: Arc::clone(&closed) });
        assert!(drain_frames(&sink).is_empty(), "port.result 应被拦截、无回帧");
        assert!(*closed.lock().unwrap(), "EOF 时应调 on_close");
    }
}
