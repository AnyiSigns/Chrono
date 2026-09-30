// 集成测试：黑盒经服务协议驱动真实 `embedding` 二进制（hello / manifest / embed）。
// 扮演宿主：读服务发来的 `port.call`，按帧内 `provider` 路由到成员：
//   - `embedding-local` / `embedding-dup*`：测试内假提供方；
//   - `embedding-fixture`：转发到真实夹具插件进程（tests/fixtures/plugins/embedding-fixture）。
// 覆盖：按 model 选成员（选 x → 路由到夹具提供方）、未知模型报错、歧义报错、
//       默认（未给 model）按成员码元序首命中，以及成员集 [local] → [local,fixture]
//       重注入后消费方可选到新成员（消费方代码 / 声明零改动）。
// 用 `test/`（非 cargo 缺省 `tests/`），由 Cargo.toml 的 `[[test]] path` 显式声明。

use std::io::{BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use serde_json::{json, Value};

use plugin_sdk::{read_frame, write_frame};

/// 夹具提供方进程：真实 `embedding-fixture` 插件（自实现最小帧循环）。
struct Fixture {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    seq: u64,
}

impl Fixture {
    fn spawn() -> Self {
        let entry = fixture_entry();
        let mut child = Command::new("node")
            .arg(&entry)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap_or_else(|err| panic!("spawn fixture {}: {err}", entry.display()));
        let stdin = child.stdin.take().expect("fixture stdin");
        let stdout = BufReader::new(child.stdout.take().expect("fixture stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            seq: 0,
        }
    }

    /// 转发一次 `embedding-provider` 调用给夹具，返回其 `{ok, value}` 或 `{ok:false, code, message}`。
    fn call(&mut self, method: &str, args: &Value) -> FixtureOutcome {
        self.seq += 1;
        let id = format!("fixture-{}", self.seq);
        let stdin = self.stdin.as_mut().expect("fixture stdin open");
        write_frame(
            stdin,
            &json!({
                "v": "1", "id": id, "kind": "call",
                "port": "embedding-provider", "method": method, "args": args,
            }),
        )
        .expect("write fixture frame");
        stdin.flush().expect("flush fixture");
        loop {
            let message = read_frame(&mut self.stdout)
                .expect("read fixture frame")
                .expect("fixture closed unexpectedly");
            if message.get("id").and_then(Value::as_str) != Some(id.as_str()) {
                continue;
            }
            if message.get("kind").and_then(Value::as_str) == Some("result") {
                return FixtureOutcome::Value(message.get("value").cloned().unwrap_or(Value::Null));
            }
            return FixtureOutcome::Error(
                message
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown_error")
                    .to_string(),
                message
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            );
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // 断 stdin（EOF）→ 夹具自退出，再回收子进程。
        self.stdin.take();
        let _ = self.child.wait();
    }
}

enum FixtureOutcome {
    Value(Value),
    Error(String, String),
}

/// 门面选择器服务：以注入的 `CHRONO_PLUGIN_MANY_NEEDS` 成员表 spawn 真实二进制。
struct Selector {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
    fixture: Option<Fixture>,
    describe_calls: Vec<String>,
    embed_calls: Vec<(String, String)>,
}

impl Selector {
    fn spawn(members: &[&str], with_fixture: bool) -> Self {
        let many = json!({ "embedding-provider": members });
        let mut child = Command::new(env!("CARGO_BIN_EXE_embedding"))
            .env("CHRONO_PLUGIN_MANY_NEEDS", many.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn embedding selector");
        let stdin = child.stdin.take().expect("selector stdin");
        let stdout = BufReader::new(child.stdout.take().expect("selector stdout"));
        Self {
            child,
            stdin: Some(stdin),
            stdout,
            fixture: with_fixture.then(Fixture::spawn),
            describe_calls: Vec::new(),
            embed_calls: Vec::new(),
        }
    }

    fn send(&mut self, message: &Value) {
        let stdin = self.stdin.as_mut().expect("selector stdin open");
        write_frame(stdin, message).expect("write selector frame");
        stdin.flush().expect("flush selector");
    }

    fn recv(&mut self) -> Value {
        read_frame(&mut self.stdout)
            .expect("read selector frame")
            .expect("selector closed unexpectedly")
    }

    /// 发一次 `embedding.embed`：驱动服务，同时应答其反向调用，返回最终结果帧。
    fn embed(&mut self, id: &str, args: Value) -> Value {
        self.send(&json!({
            "v": "1", "id": id, "kind": "call",
            "port": "embedding", "method": "embed", "args": args,
            "env": {"run": "r1", "thread": null, "now": 0.0},
        }));
        loop {
            let message = self.recv();
            if message.get("kind").and_then(Value::as_str) == Some("port.call") {
                self.answer(&message);
                continue;
            }
            if message.get("id").and_then(Value::as_str) == Some(id) {
                return message;
            }
        }
    }

    /// 应答门面发来的反向调用：按 `provider` 路由到夹具或测试内假提供方。
    fn answer(&mut self, message: &Value) {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let provider = message
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let args = message.get("args").cloned().unwrap_or(Value::Null);
        let id = message.get("id").cloned().unwrap_or(Value::Null);

        if method == "describe-models" {
            self.describe_calls.push(provider.clone());
        }
        if method == "embed" {
            let model = args
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            self.embed_calls.push((provider.clone(), model));
        }

        let outcome = if provider == "embedding-fixture" {
            let fixture = self.fixture.as_mut().expect("fixture provider not spawned");
            match fixture.call(&method, &args) {
                FixtureOutcome::Value(value) => Ok(value),
                FixtureOutcome::Error(code, message) => Err((code, message)),
            }
        } else {
            fake_provider(&provider, &method, &args)
        };

        match outcome {
            Ok(value) => self.send(&json!({
                "v": "1", "id": id, "kind": "port.result", "ok": true, "value": value,
            })),
            Err((code, message)) => self.send(&json!({
                "v": "1", "id": id, "kind": "port.error", "ok": false, "code": code, "message": message,
            })),
        }
    }

    fn hello(&mut self) -> Value {
        self.send(&json!({"v":"1","id":"h","kind":"hello","impl":"embedding"}));
        loop {
            let message = self.recv();
            if message.get("id").and_then(Value::as_str) == Some("h") {
                return message;
            }
        }
    }
}

impl Drop for Selector {
    fn drop(&mut self) {
        // 断 stdin（EOF）→ 服务自退出，再回收子进程。
        self.stdin.take();
        let _ = self.child.wait();
    }
}

fn repo_root() -> PathBuf {
    // 不用 canonicalize：Windows 下会返回 `\\?\` 扩展路径，node 解析入口时会误判。
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn fixture_entry() -> PathBuf {
    repo_root()
        .join("tests")
        .join("fixtures")
        .join("plugins")
        .join("embedding-fixture")
        .join("execute")
        .join("main.mjs")
}

/// 测试内假提供方：`embedding-local` 声明 granite-97m（4 维），`embedding-dup*` 一并声明 x（供歧义）。
fn fake_provider(provider: &str, method: &str, args: &Value) -> Result<Value, (String, String)> {
    let (model, dim) = match provider {
        "embedding-local" => ("granite-97m", 4),
        "embedding-dup" | "embedding-dup2" => ("x", 4),
        other => {
            return Err((
                "not_loaded".to_string(),
                format!("unknown fake provider {other}"),
            ))
        }
    };
    match method {
        "describe-models" => Ok(json!({ "models": [{ "model": model, "dim": dim }] })),
        "embed" => {
            let texts = args
                .get("texts")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let vectors: Vec<Value> = texts
                .iter()
                .map(|_| json!(vec![1.0, 0.0, 0.0, 0.0]))
                .collect();
            Ok(json!({ "model": model, "dim": dim, "vectors": vectors }))
        }
        other => Err((
            "unknown_method".to_string(),
            format!("fake provider unknown method {other}"),
        )),
    }
}

fn vectors_len(value: &Value) -> usize {
    value["value"]["vectors"].as_array().map(Vec::len).unwrap_or(0)
}

#[test]
fn selects_fixture_provider_by_model_and_routes_embed() {
    let mut selector = Selector::spawn(&["embedding-fixture", "embedding-local"], true);
    let manifest = selector.hello();
    assert_eq!(manifest["kind"], "manifest");
    assert_eq!(manifest["identity"], "embedding");
    assert_eq!(manifest["methods"]["embedding"], json!(["embed"]));

    let result = selector.embed("e1", json!({"texts": ["hello", "world"], "model": "x"}));
    assert_eq!(result["kind"], "result", "{result}");
    assert_eq!(result["value"]["model"], "x");
    assert_eq!(result["value"]["dim"], 8);
    assert_eq!(vectors_len(&result), 2);
    // 夹具的确定性向量：首分量 9。
    assert_eq!(result["value"]["vectors"][0][0], 9.0);
    // 对外形状保持稳定：恰好 {model, dim, vectors}。
    let mut keys: Vec<&str> = result["value"]
        .as_object()
        .expect("embed result must be an object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["dim", "model", "vectors"]);
    // 路由断言：embed 带 provider 落到夹具；两个成员都被 describe。
    assert!(selector
        .embed_calls
        .contains(&("embedding-fixture".to_string(), "x".to_string())));
    assert!(selector
        .describe_calls
        .contains(&"embedding-fixture".to_string()));
    assert!(selector.describe_calls.contains(&"embedding-local".to_string()));
}

#[test]
fn selects_local_provider_for_granite() {
    let mut selector = Selector::spawn(&["embedding-fixture", "embedding-local"], true);
    let result = selector.embed("e1", json!({"texts": ["hi"], "model": "granite-97m"}));
    assert_eq!(result["kind"], "result", "{result}");
    assert_eq!(result["value"]["model"], "granite-97m");
    assert_eq!(result["value"]["dim"], 4);
    assert_eq!(result["value"]["vectors"][0][0], 1.0);
    assert!(selector
        .embed_calls
        .contains(&("embedding-local".to_string(), "granite-97m".to_string())));
}

#[test]
fn default_model_uses_lexicographically_first_member() {
    let mut selector = Selector::spawn(&["embedding-fixture", "embedding-local"], true);
    // 成员码元序：embedding-fixture < embedding-local → 默认取夹具的 x。
    let result = selector.embed("e1", json!({"texts": ["hi"]}));
    assert_eq!(result["kind"], "result", "{result}");
    assert_eq!(result["value"]["model"], "x");
}

#[test]
fn unknown_model_without_matching_member_errors() {
    // 成员集只有 local：请求 x 无成员声明 → unknown_model。
    let mut selector = Selector::spawn(&["embedding-local"], false);
    let result = selector.embed("e1", json!({"texts": ["hi"], "model": "x"}));
    assert_eq!(result["kind"], "error", "{result}");
    assert_eq!(result["code"], "unknown_model");
}

#[test]
fn ambiguous_model_is_reported() {
    // 两个成员都声明 x → 歧义报错（字典序列候选）。
    let mut selector = Selector::spawn(&["embedding-dup", "embedding-dup2"], false);
    let result = selector.embed("e1", json!({"texts": ["hi"], "model": "x"}));
    assert_eq!(result["kind"], "error", "{result}");
    assert_eq!(result["code"], "ambiguous_model");
    let message = result["message"].as_str().unwrap_or("");
    assert!(message.contains("embedding-dup"), "{message}");
    assert!(message.contains("embedding-dup2"), "{message}");
}

#[test]
fn member_change_reinjects_and_selects_new_member() {
    // 成员集 [local]：选不到 x。
    let mut before = Selector::spawn(&["embedding-local"], false);
    let missing = before.embed("e1", json!({"texts": ["hi"], "model": "x"}));
    assert_eq!(missing["kind"], "error", "{missing}");
    assert_eq!(missing["code"], "unknown_model");
    drop(before);

    // 成员集变为 [local, fixture]（世界变更 → 宿主重启并重注入）：同一个消费方调用可选到新成员。
    let mut after = Selector::spawn(&["embedding-fixture", "embedding-local"], true);
    let found = after.embed("e1", json!({"texts": ["hi"], "model": "x"}));
    assert_eq!(found["kind"], "result", "{found}");
    assert_eq!(found["value"]["model"], "x");
    assert_eq!(found["value"]["vectors"][0][0], 9.0);
    assert!(after
        .embed_calls
        .contains(&("embedding-fixture".to_string(), "x".to_string())));
}
