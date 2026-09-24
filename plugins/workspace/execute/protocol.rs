// `workspace` 服务进程协议面（docs/protocol.md §二）：握手 / manifest / call / 控制 / EOF 自退出。
// stdout 只发协议帧，日志走 stderr；服务不读投影、无写通道：所需世界数据全由调用方随 args 传入。
// `call` 在独立线程执行（pick 会阻塞在对话框上），控制帧（probe / reload / drain）不被阻塞。

use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::body::{self, RealFs};
use crate::frames;
use crate::pick;
use crate::platform::{SystemOpener, SystemPicker};
use crate::recent;
use crate::reveal;

/// 身份名 = 能力类名（类名 = 身份名）。
pub const IDENTITY: &str = "workspace";
/// 协议版本。
pub const PROTOCOL: &str = "1";
/// 状态档：v1 只允许可重算。
pub const STATE: &str = "recomputable";

const METHODS: [&str; 5] = ["list", "pick", "add", "remove", "reveal"];

/// 调用帧的 `env`（宿主填写，机械）。本服务不落世界、不发事件，`run` / `thread` 仅原样留存备用。
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
        run: object.get("run").and_then(Value::as_str).map(str::to_string),
        thread: object.get("thread").and_then(Value::as_str).map(str::to_string),
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

/// `reveal` 目标路径：只按 `args.workspace` id 在随 args 传入的 body 里解析。
/// 不接受未校验的 `args.path`——契约只声明 `{workspace}`，路径真源是 workspace body。
fn reveal_path(args: &Value) -> Result<String, (String, String)> {
    let id = args
        .get("workspace")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ("bad_args".to_string(), "reveal requires a workspace id".to_string()))?;
    body::workspace_path(args, id).ok_or_else(|| {
        (
            "bad_args".to_string(),
            "reveal requires a workspace id resolvable in the passed body".to_string(),
        )
    })
}

/// 处理 `call`：方法分派 + 结构化错误码。
pub fn handle_call(method: &str, args: &Value, _env: &CallEnv) -> Result<Value, (String, String)> {
    let state = recent::state_dir();
    match method {
        "list" => Ok(body::list_value(args, &RealFs)),
        "pick" => pick::pick_value(&SystemPicker, state.as_deref()),
        "add" => body::add_plan(args, &RealFs),
        "remove" => body::remove_plan(args),
        "reveal" => {
            let path = reveal_path(args)?;
            Ok(reveal::reveal_value(
                &SystemOpener,
                &path,
                state.as_deref(),
            ))
        }
        other => Err(("unknown_method".to_string(), format!("unknown method {other}"))),
    }
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
        Ok(value) => json!({ "v": PROTOCOL, "id": id, "kind": "result", "ok": true, "value": value }),
        Err((code, message)) => error_frame(&id, &code, &message),
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
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let Some(guard) = InflightGuard::try_acquire(Arc::clone(&inflight)) else {
                    frames::log("call rejected: inflight limit reached");
                    if let Ok(mut writer) = out.lock() {
                        let _ = frames::write_frame(
                            &mut *writer,
                            &error_frame(&id, "overloaded", "inflight limit reached"),
                        );
                    }
                    continue;
                };
                let out = Arc::clone(&out);
                let fallback = Arc::clone(&out);
                if let Err(err) = thread::Builder::new().spawn(move || {
                    let response = call_response(&message);
                    if let Ok(mut writer) = out.lock() {
                        let _ = frames::write_frame(&mut *writer, &response);
                    }
                    // guard 随闭包结束（或 spawn 失败）而 Drop：计数必归零。
                    drop(guard);
                }) {
                    frames::log(&format!("spawn call failed: {err}"));
                    if let Ok(mut writer) = fallback.lock() {
                        let _ = frames::write_frame(
                            &mut *writer,
                            &error_frame(&id, "spawn_failed", &err.to_string()),
                        );
                    }
                }
            }
            "drain" => {
                let id = message.get("id").cloned().unwrap_or(Value::Null);
                let deadline = message.get("deadline_ms").and_then(Value::as_u64).unwrap_or(5000);
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
        assert_eq!(value["identity"], "workspace");
        assert_eq!(value["implements"], json!(["workspace"]));
        assert_eq!(
            value["methods"]["workspace"],
            json!(["list", "pick", "add", "remove", "reveal"])
        );
        assert_eq!(value["state"], "recomputable");
    }

    #[test]
    fn hello_returns_manifest() {
        let response = handle_control(&json!({"kind":"hello","id":"h1","impl":"workspace"})).unwrap();
        assert_eq!(response["kind"], "manifest");
        assert_eq!(response["id"], "h1");
        assert_eq!(response["identity"], "workspace");
    }

    #[test]
    fn probe_returns_pong() {
        let response = handle_control(&json!({"kind":"probe","id":"p1"})).unwrap();
        assert_eq!(response["kind"], "pong");
        assert_eq!(response["ok"], true);
    }

    #[test]
    fn reload_returns_ack() {
        let response = handle_control(&json!({"kind":"reload","id":"r1","gen":"g"})).unwrap();
        assert_eq!(response["kind"], "ack");
    }

    #[test]
    fn unknown_method_is_structured_error() {
        let err = handle_call("nope", &json!({}), &CallEnv::default()).unwrap_err();
        assert_eq!(err.0, "unknown_method");
    }

    #[test]
    fn list_with_empty_body_is_empty_array() {
        let value = handle_call("list", &json!({}), &CallEnv::default()).unwrap();
        assert_eq!(value, json!([]));
    }

    #[test]
    fn unknown_capability_is_unresolved() {
        let response = call_response(
            &json!({"kind":"call","id":"c1","port":"other","method":"list","args":{}}),
        );
        assert_eq!(response["kind"], "error");
        assert_eq!(response["code"], "unresolved_cap");
    }

    #[test]
    fn reveal_without_resolvable_workspace_is_bad_args() {
        let err = handle_call("reveal", &json!({"workspace": "w"}), &CallEnv::default())
            .unwrap_err();
        assert_eq!(err.0, "bad_args");
        // 未校验的 args.path 不再被接受。
        let err = handle_call(
            "reveal",
            &json!({"workspace": "w", "path": "C:\\anywhere"}),
            &CallEnv::default(),
        )
        .unwrap_err();
        assert_eq!(err.0, "bad_args");
    }

    #[test]
    fn reveal_path_resolves_from_body() {
        let args = json!({
            "workspace": "w1",
            "body": { "version": 1, "workspaces": [ { "id": "w1", "path": "C:\\ws" } ] },
        });
        assert_eq!(reveal_path(&args).unwrap(), "C:\\ws");
    }

    #[test]
    fn loop_handshake_then_eof_exits() {
        let mut bytes =
            encode_frame(&json!({"v":"1","id":"h","kind":"hello","impl":"workspace"})).unwrap();
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
