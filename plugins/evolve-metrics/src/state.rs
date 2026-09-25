// ③ 可重算缓存（住宿主侧 `state/plugins/evolve-metrics/`，经 `CHRONO_PLUGIN_STATE` 注入）。
// 只缓存「可由轨迹窗口重算」的基线统计；命中与未命中输出逐字节一致（计算是确定性的）。
// 缓存丢失只影响一次重算，不影响正确性——故本插件声明 ③（state: recomputable）。

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;

/// 缓存读写面；实现须容忍缺失 / 损坏（缺失 / 损坏按未命中处理，不报错）。
pub trait StateStore: Send + Sync {
    fn read(&self, key: &str) -> Option<Value>;
    fn write(&self, key: &str, value: &Value);
}

/// 进程内缓存：测试与无 ③ 目录时使用（语义与文件实现一致，只是不持久）。
#[derive(Default)]
pub struct MemoryStateStore {
    entries: Mutex<BTreeMap<String, Value>>,
}

impl MemoryStateStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl StateStore for MemoryStateStore {
    fn read(&self, key: &str) -> Option<Value> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .cloned()
    }

    fn write(&self, key: &str, value: &Value) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key.to_string(), value.clone());
    }
}

/// 文件缓存：单文件 `baselines.json`，内容为 `{key: value}`；读取失败按空表处理。
pub struct FileStateStore {
    file: PathBuf,
    entries: Mutex<BTreeMap<String, Value>>,
}

impl FileStateStore {
    /// 从 `CHRONO_PLUGIN_STATE` 定位缓存文件；无该环境变量时退化为进程内缓存。
    pub fn from_env() -> Self {
        match std::env::var("CHRONO_PLUGIN_STATE") {
            Ok(dir) if !dir.is_empty() => Self::at(PathBuf::from(dir).join("baselines.json")),
            _ => Self::at(PathBuf::new()),
        }
    }

    /// 指定缓存文件路径（空路径 = 纯内存）。
    pub fn at(file: PathBuf) -> Self {
        let entries = load(&file).unwrap_or_default();
        Self {
            file,
            entries: Mutex::new(entries),
        }
    }

    fn persist(&self, entries: &BTreeMap<String, Value>) {
        if self.file.as_os_str().is_empty() {
            return;
        }
        let Ok(text) = serde_json::to_string(entries) else {
            return;
        };
        // 缓存是 ③：写失败不致命，下次重算即可。临时文件 + rename 防半截 / 并发覆盖。
        if let Err(err) = atomic_replace(&self.file, text.as_bytes()) {
            crate::frames::log(&format!("baselines.json write failed: {err}"));
        }
    }
}

fn load(file: &std::path::Path) -> Option<BTreeMap<String, Value>> {
    if file.as_os_str().is_empty() {
        return None;
    }
    let text = fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

/// 原子替换：同目录唯一临时名（pid + 序号）写入后 `rename`。
/// 仅对 `PermissionDenied` 退避重试（Windows 共享冲突多映射于此：目标被占用时 rename 短暂失败）；
/// 其余错误立即返回，不掩盖真实故障。
/// 诚实标注：只 `sync_all` 临时文件，未 fsync 父目录项；掉电窗口内目录项可能未落盘，
/// 本文件是 ③ 缓存、丢失仅触发一次重算，故接受该窗口。
fn atomic_replace(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().unwrap_or_else(|| std::path::Path::new("."));
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "baselines.json".to_string());
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

impl StateStore for FileStateStore {
    fn read(&self, key: &str) -> Option<Value> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
            .cloned()
    }

    fn write(&self, key: &str, value: &Value) {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 锁内重读盘上内容再合并：只能合并**已落盘**的写入；进程内 best-effort，跨进程并发写仍可能丢更新。
        if let Some(disk) = load(&self.file) {
            *entries = disk;
        }
        entries.insert(key.to_string(), value.clone());
        self.persist(&entries);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn memory_store_round_trip() {
        let store = MemoryStateStore::new();
        assert!(store.read("k").is_none());
        store.write("k", &json!({"v": 1}));
        assert_eq!(store.read("k"), Some(json!({"v": 1})));
    }

    #[test]
    fn file_store_persists_and_recovers() {
        let dir = std::env::temp_dir().join(format!(
            "chrono-evolve-metrics-state-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("baselines.json");
        {
            let store = FileStateStore::at(file.clone());
            store.write("w1|agent.step", &json!({"tokens": 10.0}));
        }
        let reopened = FileStateStore::at(file);
        assert_eq!(reopened.read("w1|agent.step"), Some(json!({"tokens": 10.0})));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn corrupt_file_is_a_miss() {
        let dir = std::env::temp_dir().join(format!(
            "chrono-evolve-metrics-corrupt-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("baselines.json");
        fs::write(&file, "{not json").unwrap();
        let store = FileStateStore::at(file);
        assert!(store.read("k").is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_store_merges_disk_before_write() {
        let dir = std::env::temp_dir().join(format!(
            "chrono-evolve-metrics-merge-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("baselines.json");
        let first = FileStateStore::at(file.clone());
        first.write("a", &json!({"v": 1}));
        // 模拟另一进程（独立实例）：写 b。
        let second = FileStateStore::at(file.clone());
        second.write("b", &json!({"v": 2}));
        // 第一个实例再写 c：锁内重读盘，不得用旧内存快照覆盖 b。
        first.write("c", &json!({"v": 3}));
        let reopened = FileStateStore::at(file);
        assert_eq!(reopened.read("a"), Some(json!({"v": 1})));
        assert_eq!(reopened.read("b"), Some(json!({"v": 2})));
        assert_eq!(reopened.read("c"), Some(json!({"v": 3})));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_file_writes_do_not_lose_entries() {
        let dir = std::env::temp_dir().join(format!(
            "chrono-evolve-metrics-concurrent-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("baselines.json");
        let store = FileStateStore::at(file.clone());
        std::thread::scope(|scope| {
            for index in 0..8 {
                let store = &store;
                scope.spawn(move || store.write(&format!("k{index}"), &json!({"v": index})));
            }
        });
        let reopened = FileStateStore::at(file);
        for index in 0..8 {
            assert_eq!(
                reopened.read(&format!("k{index}")),
                Some(json!({"v": index}))
            );
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
