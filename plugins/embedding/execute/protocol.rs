// `embedding` 服务进程协议面（docs/protocol.md §二）：握手 / manifest / call / 控制 / EOF 自退出。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需输入全由调用方随 bag 传入。
// `call` 在独立线程执行（推理可能较慢），控制帧（probe / reload / drain）不被阻塞。

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::chunk;
use crate::frames;
use crate::model;
use crate::tokenizer;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "embedding";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：v1 只允许可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 2] = ["embed", "chunk"];

/// 调用帧的 `env`（宿主填写，机械）。本服务不落世界、不发事件，仅留存备用。
#[derive(Clone, Debug, Default)]
pub struct CallEnv {
    #[allow(dead_code)]
    pub run: Option<String>,
    #[allow(dead_code)]
    pub thread: Option<String>,
    #[allow(dead_code)]
    pub now: f64,
}

fn parse_env(raw: Option<&Value>) -> CallEnv {
    let Some(object) = raw.and_then(Value::as_object) else {
        return CallEnv::default();
    };
    CallEnv {
        run: object
            .get("run")
            .and_then(Value::as_str)
            .map(str::to_string),
        thread: object
            .get("thread")
            .and_then(Value::as_str)
            .map(str::to_string),
        now: object.get("now").and_then(Value::as_f64).unwrap_or(0.0),
    }
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

/// 处理控制帧；返回待写响应（`call` / `drain` / 未知种类由调用方处理）。
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

/// 处理 `call`：能力类 / 方法 / args 形态门禁 + 方法分派。
pub fn handle_call(method: &str, args: &Value, _env: &CallEnv) -> Result<Value, (String, String)> {
    match method {
        "embed" => handle_embed(args),
        "chunk" => handle_chunk(args),
        other => Err((
            "unknown_method".to_string(),
            format!("unknown method {other}"),
        )),
    }
}

fn handle_embed(args: &Value) -> Result<Value, (String, String)> {
    let requested_model = args
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or(model::MODEL_ID);
    if requested_model != model::MODEL_ID {
        return Err((
            "unknown_model".to_string(),
            format!("unknown model {requested_model}"),
        ));
    }
    let raw_texts = args
        .get("texts")
        .and_then(Value::as_array)
        .ok_or_else(|| ("bad_args".to_string(), "texts must be an array".to_string()))?;
    let mut texts = Vec::with_capacity(raw_texts.len());
    for item in raw_texts {
        let text = item.as_str().ok_or_else(|| {
            (
                "bad_args".to_string(),
                "texts items must be strings".to_string(),
            )
        })?;
        texts.push(text.to_string());
    }
    let engine = model::engine().map_err(|error| (error.code, error.message))?;
    let vectors = engine
        .embed(&texts)
        .map_err(|error| (error.code, error.message))?;
    Ok(json!({
        "model": model::MODEL_ID,
        "dim": model::DIM,
        "vectors": vectors,
    }))
}

fn handle_chunk(args: &Value) -> Result<Value, (String, String)> {
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| ("bad_args".to_string(), "text must be a string".to_string()))?;
    let options = chunk::parse_options(args)?;
    let tokenizer =
        tokenizer::shared().map_err(|message| ("model_load_failed".to_string(), message))?;
    let chunks = chunk::chunk_text(tokenizer, text, &options)?;
    Ok(Value::Array(chunks))
}

fn call_response(message: &Value) -> Value {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let port = message.get("port").and_then(Value::as_str).unwrap_or("");
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    let env = parse_env(message.get("env"));
    if port != IDENTITY {
        return error_frame(&id, "unresolved_cap", &format!("unknown capability {port}"));
    }
    match handle_call(method, &args, &env) {
        Ok(value) => {
            json!({ "v": PROTOCOL, "id": id, "kind": "result", "ok": true, "value": value })
        }
        Err((code, message)) => error_frame(&id, &code, &message),
    }
}

fn wait_for_inflight(inflight: &Arc<(Mutex<usize>, Condvar)>, deadline_ms: u64) {
    let (lock, cvar) = &**inflight;
    let mut count = lock.lock().expect("inflight poisoned");
    let deadline = Instant::now() + Duration::from_millis(deadline_ms);
    while *count > 0 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        let (next, timeout) = cvar
            .wait_timeout(count, remaining)
            .expect("inflight poisoned");
        count = next;
        if timeout.timed_out() {
            break;
        }
    }
}

/// 帧循环：`call` 独立线程执行；`drain` 等在途结束再 `bye`；EOF（stdin 断开）即自退出。
pub fn run_loop<R: Read, W: Write + Send + 'static>(mut reader: R, writer: W) {
    let out = Arc::new(Mutex::new(writer));
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
        match message.get("kind").and_then(Value::as_str).unwrap_or("") {
            "call" => {
                {
                    let (lock, _) = &*inflight;
                    *lock.lock().expect("inflight poisoned") += 1;
                }
                let out = Arc::clone(&out);
                let inflight = Arc::clone(&inflight);
                thread::spawn(move || {
                    let response = call_response(&message);
                    if let Ok(mut guard) = out.lock() {
                        let _ = frames::write_frame(&mut *guard, &response);
                    }
                    let (lock, cvar) = &*inflight;
                    let mut count = lock.lock().expect("inflight poisoned");
                    *count = count.saturating_sub(1);
                    cvar.notify_all();
                });
            }
            "drain" => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let deadline = message
                    .get("deadline_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(5000);
                wait_for_inflight(&inflight, deadline);
                if let Ok(mut guard) = out.lock() {
                    let _ = frames::write_frame(
                        &mut *guard,
                        &json!({ "v": PROTOCOL, "id": id, "kind": "bye" }),
                    );
                }
                return;
            }
            _ => {
                if let Some(response) = handle_control(&message) {
                    if let Ok(mut guard) = out.lock() {
                        let _ = frames::write_frame(&mut *guard, &response);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frames::encode_frame;

    #[test]
    fn manifest_matches_declaration() {
        let value = manifest();
        assert_eq!(value["identity"], "embedding");
        assert_eq!(value["implements"], json!(["embedding"]));
        assert_eq!(value["methods"]["embedding"], json!(["embed", "chunk"]));
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn hello_returns_manifest() {
        let response =
            handle_control(&json!({"kind":"hello","id":"h1","impl":"embedding"})).unwrap();
        assert_eq!(response["kind"], "manifest");
        assert_eq!(response["id"], "h1");
        assert_eq!(response["identity"], "embedding");
    }

    #[test]
    fn probe_returns_pong() {
        let response = handle_control(&json!({"kind":"probe","id":"p1"})).unwrap();
        assert_eq!(response["kind"], "pong");
        assert_eq!(response["ok"], true);
    }

    #[test]
    fn reload_acks() {
        let response = handle_control(&json!({"kind":"reload","id":"r1","gen":"g"})).unwrap();
        assert_eq!(response["kind"], "ack");
        assert_eq!(response["id"], "r1");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn embed_rejects_bad_args_and_unknown_model() {
        assert_eq!(
            handle_call("embed", &json!({"texts": "nope"}), &CallEnv::default())
                .unwrap_err()
                .0,
            "bad_args"
        );
        assert_eq!(
            handle_call(
                "embed",
                &json!({"texts": ["hi"], "model": "other"}),
                &CallEnv::default()
            )
            .unwrap_err()
            .0,
            "unknown_model"
        );
    }

    #[test]
    fn chunk_rejects_bad_args() {
        assert_eq!(
            handle_call("chunk", &json!({}), &CallEnv::default())
                .unwrap_err()
                .0,
            "bad_args"
        );
        assert_eq!(
            handle_call(
                "chunk",
                &json!({"text": "x", "window": 4, "overlap": 9}),
                &CallEnv::default()
            )
            .unwrap_err()
            .0,
            "bad_args"
        );
    }

    #[test]
    fn embed_returns_model_dim_and_vectors() {
        let value = handle_call(
            "embed",
            &json!({"texts": ["hello", "你好"]}),
            &CallEnv::default(),
        )
        .unwrap();
        assert_eq!(value["model"], "granite-97m");
        assert_eq!(value["dim"], 384);
        assert_eq!(value["vectors"].as_array().unwrap().len(), 2);
        assert_eq!(value["vectors"][0].as_array().unwrap().len(), 384);
    }

    #[test]
    fn chunk_returns_codepoint_offsets() {
        let value = handle_call(
            "chunk",
            &json!({"text": "你好，world", "window": 512, "overlap": 64}),
            &CallEnv::default(),
        )
        .unwrap();
        let chunks = value.as_array().unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0]["start"], 0);
        assert_eq!(chunks[0]["end"], "你好，world".chars().count());
        assert_eq!(chunks[0]["text"], "你好，world");
    }

    #[test]
    fn unknown_capability_is_unresolved() {
        let response = call_response(
            &json!({"kind":"call","id":"c1","port":"other","method":"chunk","args":{}}),
        );
        assert_eq!(response["kind"], "error");
        assert_eq!(response["code"], "unresolved_cap");
    }

    #[test]
    fn loop_handshake_then_eof_exits() {
        let mut bytes =
            encode_frame(&json!({"v":"1","id":"h","kind":"hello","impl":"embedding"})).unwrap();
        bytes.extend_from_slice(&encode_frame(&json!({"v":"1","id":"p","kind":"probe"})).unwrap());
        let out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let sink = Arc::clone(&out);
            run_loop(std::io::Cursor::new(bytes), SharedWriter(sink));
        }
        let written = out.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(written);
        let manifest = frames::read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(manifest["kind"], "manifest");
        let pong = frames::read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(pong["kind"], "pong");
        assert!(frames::read_frame(&mut cursor).unwrap().is_none());
    }

    #[test]
    fn loop_drain_responds_bye() {
        let bytes =
            encode_frame(&json!({"v":"1","id":"d","kind":"drain","deadline_ms":10})).unwrap();
        let out: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        {
            let sink = Arc::clone(&out);
            run_loop(std::io::Cursor::new(bytes), SharedWriter(sink));
        }
        let written = out.lock().unwrap().clone();
        let mut cursor = std::io::Cursor::new(written);
        let bye = frames::read_frame(&mut cursor).unwrap().unwrap();
        assert_eq!(bye["kind"], "bye");
        assert_eq!(bye["id"], "d");
    }

    /// 测试用共享写端：把 run_loop 的输出收进内存。
    struct SharedWriter(Arc<Mutex<Vec<u8>>>);

    impl Write for SharedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
