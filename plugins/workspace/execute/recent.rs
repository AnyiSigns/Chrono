// 最近打开（本机 ③）：`CHRONO_PLUGIN_STATE/recent.json`，形状 `{recent:[…]}`。
// 按最近优先（顺序即 LRU，无时间戳）、前插去重、上限 10；丢失只影响便利性，不进世界、不参与哈希。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};

/// 最近打开上限。
pub const RECENT_LIMIT: usize = 10;
/// ③ 目录内的文件名。
pub const RECENT_FILE: &str = "recent.json";

/// 进程内 RMW 互斥：锁内重读-改-写，避免同进程并发 `record` 互相覆盖。
/// 进程内 best-effort：跨进程并发写仍可能丢更新（③ 缓存，丢失只影响便利性）。
static RECENT_LOCK: Mutex<()> = Mutex::new(());

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

/// 原子替换：同目录唯一临时名（pid + 序号）写入后 `rename`。
/// 仅对 `PermissionDenied` 退避重试（Windows 共享冲突多映射于此：目标被占用时 rename 短暂失败）；
/// 其余错误立即返回，不掩盖真实故障。
/// 诚实标注：只 `sync_all` 临时文件，未 fsync 父目录项；掉电窗口内目录项可能未落盘，
/// 本文件是 ③ 缓存、丢失仅触发一次重算，故接受该窗口。
fn atomic_replace(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| RECENT_FILE.to_string());
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".{name}.chrono-tmp-{}-{seq}", std::process::id()));
    {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    let mut last: Option<std::io::Error> = None;
    for attempt in 0..10u32 {
        match fs::rename(&temp, path) {
            Ok(()) => return Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                last = Some(err);
                std::thread::sleep(std::time::Duration::from_millis(5 * u64::from(attempt + 1)));
            }
            Err(err) => {
                let _ = fs::remove_file(&temp);
                return Err(err);
            }
        }
    }
    let _ = fs::remove_file(&temp);
    Err(last.unwrap_or_else(|| std::io::Error::other("rename failed")))
}

/// 前插去重、截断到上限并落盘；返回新列表。写盘失败不致命。
pub fn record(dir: &Path, path: &str) -> Vec<String> {
    let _guard = RECENT_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut list = load(dir);
    list.retain(|item| item != path);
    list.insert(0, path.to_string());
    list.truncate(RECENT_LIMIT);
    if let Ok(bytes) = serde_json::to_vec_pretty(&json!({ "recent": list })) {
        // 缓存是 ③：写失败不致命，下次重算即可；但仍记日志，不静默吞错。
        if let Err(err) = atomic_replace(&dir.join(RECENT_FILE), &bytes) {
            crate::frames::log(&format!("recent.json write failed: {err}"));
        }
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

    #[test]
    fn concurrent_records_do_not_lose_updates() {
        let dir = temp_dir("concurrent");
        std::thread::scope(|scope| {
            for index in 0..8 {
                let dir = dir.clone();
                scope.spawn(move || {
                    record(&dir, &format!("p{index}"));
                });
            }
        });
        let list = load(&dir);
        assert_eq!(list.len(), 8, "{list:?}");
        for index in 0..8 {
            assert!(list.contains(&format!("p{index}")), "{list:?}");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_replace_replaces_and_leaves_no_temp() {
        let dir = temp_dir("atomic");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join(RECENT_FILE);
        atomic_replace(&target, b"{\"recent\":[\"a\"]}").unwrap();
        atomic_replace(&target, b"{\"recent\":[\"b\"]}").unwrap();
        assert_eq!(load(&dir), vec!["b".to_string()]);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains("chrono-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }
}
