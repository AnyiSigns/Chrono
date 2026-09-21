// `reveal` 逻辑层：在系统文件管理器中打开目标路径。`Opener` trait 注入以便测试；
// 纯动作——不写世界、不经槽；成功时记 ③ 最近打开（本机便利性，不参与重放）。

use std::path::Path;

use serde_json::{json, Value};

use crate::recent;

/// 系统文件管理器拉起器（平台实现见 `platform`）。
pub trait Opener {
    fn open(&self, path: &str) -> Result<(), String>;
}

/// `reveal`：成功 → `{ok:true}`；拉起失败 → `{ok:false,error:'reveal_failed'}`。
pub fn reveal_value(opener: &dyn Opener, path: &str, state_dir: Option<&Path>) -> Value {
    match opener.open(path) {
        Ok(()) => {
            if let Some(dir) = state_dir {
                recent::record(dir, path);
            }
            json!({ "ok": true })
        }
        Err(_) => json!({ "ok": false, "error": "reveal_failed" }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeOpener(Result<(), String>);

    impl Opener for FakeOpener {
        fn open(&self, _path: &str) -> Result<(), String> {
            self.0.clone()
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "chrono-workspace-reveal-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn success_returns_ok_and_records_recent() {
        let dir = temp_dir("ok");
        let value = reveal_value(&FakeOpener(Ok(())), "/ws", Some(&dir));
        assert_eq!(value, json!({ "ok": true }));
        assert_eq!(recent::load(&dir), vec!["/ws".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failure_returns_reveal_failed() {
        let value = reveal_value(&FakeOpener(Err("boom".to_string())), "/ws", None);
        assert_eq!(value, json!({ "ok": false, "error": "reveal_failed" }));
    }
}
