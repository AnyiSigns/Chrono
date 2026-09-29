// 平台实现：`SystemPicker`（原生目录选择器）与 `SystemOpener`（系统文件管理器）。
// 测试不依赖本模块；对话框本身在 win32 走 `IFileOpenDialog`，其它平台诚实报不可用。

use crate::pick::{PickOutcome, Picker};
use crate::reveal::Opener;

/// 系统原生目录选择器。
pub struct SystemPicker;

impl Picker for SystemPicker {
    fn pick(&self) -> PickOutcome {
        #[cfg(windows)]
        {
            crate::win32::pick_folder()
        }
        #[cfg(not(windows))]
        {
            PickOutcome::Unavailable(
                "native folder picker is only implemented on win32".to_string(),
            )
        }
    }
}

/// 系统文件管理器拉起器：win32 `explorer`、mac `open`、其它 `xdg-open`。
pub struct SystemOpener;

impl Opener for SystemOpener {
    fn open(&self, path: &str) -> Result<(), String> {
        #[cfg(windows)]
        let command = "explorer";
        #[cfg(target_os = "macos")]
        let command = "open";
        #[cfg(not(any(windows, target_os = "macos")))]
        let command = "xdg-open";

        std::process::Command::new(command)
            .arg(path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|err| err.to_string())
    }
}
