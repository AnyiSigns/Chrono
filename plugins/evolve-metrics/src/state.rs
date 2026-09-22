// ③ 可重算缓存（住宿主侧 `state/plugins/evolve-metrics/`，经 `CHRONO_PLUGIN_STATE` 注入）。
// 只缓存「可由轨迹窗口重算」的基线统计；命中与未命中输出逐字节一致（计算是确定性的）。
// 缓存丢失只影响一次重算，不影响正确性——故本插件只允许 ③（state: recomputable）。

use std::collections::BTreeMap;
use std::fs;
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
        if let Some(parent) = self.file.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let Ok(text) = serde_json::to_string(entries) else {
            return;
        };
        // 缓存是 ③：写失败不致命，下次重算即可。
        let _ = fs::write(&self.file, text);
    }
}

fn load(file: &std::path::Path) -> Option<BTreeMap<String, Value>> {
    if file.as_os_str().is_empty() {
        return None;
    }
    let text = fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
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
}
