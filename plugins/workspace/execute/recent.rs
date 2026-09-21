// 最近打开（本机 ③）：`CHRONO_PLUGIN_STATE/recent.json`，形状 `{recent:[…]}`。
// 按最近优先（顺序即 LRU，无时间戳）、前插去重、上限 10；丢失只影响便利性，不进世界、不参与哈希。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 最近打开上限。
pub const RECENT_LIMIT: usize = 10;
/// ③ 目录内的文件名。
pub const RECENT_FILE: &str = "recent.json";

/// 插件 ③ 目录（宿主以 `CHRONO_PLUGIN_STATE` 注入）；未注入时返回 None。
pub fn state_dir() -> Option<PathBuf> {
    std::env::var_os("CHRONO_PLUGIN_STATE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

/// 读最近打开列表；文件缺失 / 损坏一律回落空表（③ 只影响便利性）。
pub fn load(dir: &Path) -> Vec<String> {
    let Ok(text) = fs::read_to_string(dir.join(RECENT_FILE)) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    value
        .get("recent")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// 前插去重、截断到上限并落盘；返回新列表。写盘失败不致命。
pub fn record(dir: &Path, path: &str) -> Vec<String> {
    let mut list = load(dir);
    list.retain(|item| item != path);
    list.insert(0, path.to_string());
    list.truncate(RECENT_LIMIT);
    if let Ok(bytes) = serde_json::to_vec_pretty(&json!({ "recent": list })) {
        let _ = fs::create_dir_all(dir);
        let _ = fs::write(dir.join(RECENT_FILE), bytes);
    }
    list
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "chrono-workspace-recent-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn record_front_inserts_and_dedupes() {
        let dir = temp_dir("dedupe");
        record(&dir, "a");
        record(&dir, "b");
        record(&dir, "a");
        assert_eq!(load(&dir), vec!["a".to_string(), "b".to_string()]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_caps_at_limit() {
        let dir = temp_dir("cap");
        for index in 0..15 {
            record(&dir, &format!("p{index}"));
        }
        let list = load(&dir);
        assert_eq!(list.len(), RECENT_LIMIT);
        assert_eq!(list[0], "p14");
        assert_eq!(list[RECENT_LIMIT - 1], "p5");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_missing_or_broken_is_empty() {
        let dir = temp_dir("broken");
        assert!(load(&dir).is_empty());
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(RECENT_FILE), b"not json").unwrap();
        assert!(load(&dir).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn state_dir_reads_env() {
        // 不修改进程环境（测试并行安全），只验证函数在未注入时的收口。
        if std::env::var_os("CHRONO_PLUGIN_STATE").is_none() {
            assert!(state_dir().is_none());
        }
    }
}
