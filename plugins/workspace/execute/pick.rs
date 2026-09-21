// `pick` 逻辑层：把「打开系统对话框」与「方法逻辑」分层——`Picker` trait 注入，
// 逻辑层只做结果收口（成功记最近打开 / 取消 / 不可用）与协议错误码映射。

use std::path::Path;

use serde_json::{json, Value};

use crate::recent;

/// 选择器结果：取消是正常值，不可用是结构化错误。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickOutcome {
    Picked(String),
    Cancelled,
    Unavailable(String),
}

/// 系统原生目录选择器（平台实现见 `platform` / `win32`）。
pub trait Picker {
    fn pick(&self) -> PickOutcome;
}

/// `pick`：成功 → `{path}` 且记 ③ 最近打开；取消 → `{cancelled:true}`；
/// 无图形会话 / 选择器不可用 → 协议错误 `picker_unavailable`。
pub fn pick_value(picker: &dyn Picker, state_dir: Option<&Path>) -> Result<Value, (String, String)> {
    match picker.pick() {
        PickOutcome::Picked(path) => {
            if let Some(dir) = state_dir {
                recent::record(dir, &path);
            }
            Ok(json!({ "path": path }))
        }
        PickOutcome::Cancelled => Ok(json!({ "cancelled": true })),
        PickOutcome::Unavailable(reason) => Err(("picker_unavailable".to_string(), reason)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakePicker(PickOutcome);

    impl Picker for FakePicker {
        fn pick(&self) -> PickOutcome {
            self.0.clone()
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "chrono-workspace-pick-{}-{}-{}",
            std::process::id(),
            tag,
            n
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn picked_records_recent() {
        let dir = temp_dir("ok");
        let value = pick_value(&FakePicker(PickOutcome::Picked("C:\\ws".to_string())), Some(&dir))
            .unwrap();
        assert_eq!(value, json!({ "path": "C:\\ws" }));
        assert_eq!(recent::load(&dir), vec!["C:\\ws".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn picked_without_state_dir_still_succeeds() {
        let value = pick_value(&FakePicker(PickOutcome::Picked("/ws".to_string())), None).unwrap();
        assert_eq!(value, json!({ "path": "/ws" }));
    }

    #[test]
    fn cancelled_is_a_value() {
        let value = pick_value(&FakePicker(PickOutcome::Cancelled), None).unwrap();
        assert_eq!(value, json!({ "cancelled": true }));
    }

    #[test]
    fn unavailable_maps_to_picker_unavailable() {
        let err = pick_value(
            &FakePicker(PickOutcome::Unavailable("no display".to_string())),
            None,
        )
        .unwrap_err();
        assert_eq!(err.0, "picker_unavailable");
        assert_eq!(err.1, "no display");
    }
}
