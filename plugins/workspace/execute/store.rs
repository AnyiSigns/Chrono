// workspace 清单（工作区列表）的运行记录存储（④ `CHRONO_PLUGIN_DATA`）。
// 清单已出世界：单文件追加日志 `workspace.jsonl`，每条 `{t:'body', run, body}`；启动重放取最后一条 body。
// 每条记录盖回合 id（`run`）：同内容重复写幂等短路；中途崩只留完整前缀（半写行跳过）。
// 存量不搬：存储从空开始，旧世界世代留在链上但不再被读。

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use serde_json::{json, Value};

/// ④ 目录内的文件名。
pub const DATA_FILE: &str = "workspace.jsonl";

/// 空清单：无工作区。
pub fn empty_body() -> Value {
    json!({ "version": 1, "workspaces": [] })
}

/// 插件 ④ 目录（宿主以 `CHRONO_PLUGIN_DATA` 注入）；未注入时返回 None。
pub fn data_dir() -> Option<PathBuf> {
    std::env::var_os("CHRONO_PLUGIN_DATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// 工作区清单存储：内存态 + 追加日志。
pub struct Store {
    file: Option<PathBuf>,
    body: Value,
}

impl Store {
    /// 从 spawn env 打开：④ 路径取 `CHRONO_PLUGIN_DATA`；启动重放取最后一条 body。
    pub fn open() -> Store {
        let Some(dir) = data_dir() else {
            return Store { file: None, body: empty_body() };
        };
        let _ = fs::create_dir_all(&dir);
        let file = dir.join(DATA_FILE);
        let body = replay(&file);
        Store { file: Some(file), body }
    }

    /// 内存态存储（无 ④ 注入；测试用）。
    pub fn memory(body: Value) -> Store {
        Store { file: None, body }
    }

    /// 整份清单（工作区列表）。
    pub fn body(&self) -> &Value {
        &self.body
    }

    /// 工作区数组（缺失回空切片引用）。
    pub fn workspaces(&self) -> Vec<Value> {
        self.body
            .get("workspaces")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    /// 写入新清单（边跑边追加）；内容未变短路，返回是否落盘。
    pub fn write(&mut self, run: Option<&str>, body: Value) -> bool {
        if self.body == body {
            return false;
        }
        self.body = body.clone();
        append_record(self.file.as_deref(), run, &body);
        true
    }
}

/// 从追加日志重放：末行半写撕裂 / 坏行跳过（fail-open），取最后一条完整 body。
fn replay(path: &std::path::Path) -> Value {
    let Ok(text) = fs::read_to_string(path) else {
        return empty_body();
    };
    let mut body = empty_body();
    for line in text.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if record.get("t").and_then(Value::as_str) != Some("body") {
            continue;
        }
        if let Some(next) = record.get("body").filter(|value| value.is_object()) {
            body = next.clone();
        }
    }
    body
}

/// 追加一条记录并 `sync_all`；目录缺失时静默（纯内存降级，仅测试无 ④ 注入时发生）。
fn append_record(path: Option<&std::path::Path>, run: Option<&str>, body: &Value) {
    let Some(path) = path else {
        return;
    };
    let record = json!({ "t": "body", "run": run, "body": body });
    let Ok(line) = serde_json::to_string(&record) else {
        return;
    };
    match OpenOptions::new().create(true).append(true).open(path) {
        Ok(mut file) => {
            if file.write_all(line.as_bytes()).is_ok() && file.write_all(b"\n").is_ok() {
                let _ = file.sync_all();
            }
        }
        Err(err) => crate::frames::log(&format!("workspace store append failed: {err}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "chrono-workspace-store-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn replay_missing_or_broken_is_empty() {
        let dir = temp_dir("broken");
        assert_eq!(replay(&dir.join(DATA_FILE)), empty_body());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(DATA_FILE), b"{bad\n").unwrap();
        assert_eq!(replay(&dir.join(DATA_FILE)), empty_body());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_and_replay_last_body() {
        let dir = temp_dir("append");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(DATA_FILE);
        append_record(Some(&file), Some("run-1"), &json!({ "version": 1, "workspaces": [{ "id": "a" }] }));
        append_record(Some(&file), Some("run-2"), &json!({ "version": 1, "workspaces": [{ "id": "b" }] }));
        let body = replay(&file);
        assert_eq!(body["workspaces"][0]["id"], "b");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_is_idempotent_for_same_body() {
        let dir = temp_dir("idempotent");
        fs::create_dir_all(&dir).unwrap();
        let mut store = Store { file: Some(dir.join(DATA_FILE)), body: empty_body() };
        let body = json!({ "version": 1, "workspaces": [{ "id": "a" }] });
        assert!(store.write(Some("run-1"), body.clone()));
        assert!(!store.write(Some("run-2"), body));
        let _ = fs::remove_dir_all(&dir);
    }
}
