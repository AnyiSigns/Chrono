// win32 原生目录选择器：`IFileOpenDialog` + `FOS_PICKFOLDERS`（COM / Shell，不引入 GUI 框架）。
// 无图形会话、COM 初始化失败、对话框创建失败 → Unavailable（协议侧 `picker_unavailable`）；
// 用户取消 → Cancelled。所有 OS 调用集中在此，逻辑层不直接碰 COM。

#![cfg(windows)]

use std::ffi::c_void;

use windows::core::PWSTR;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, FILEOPENDIALOGOPTIONS, FOS_FORCEFILESYSTEM, FOS_NOCHANGEDIR,
    FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
};

use crate::pick::PickOutcome;

/// `HRESULT_FROM_WIN32(ERROR_CANCELLED)`（1223）——用户取消。
const ERROR_CANCELLED_HRESULT: i32 = 0x8007_04C7u32 as i32;
/// `RPC_E_CHANGED_MODE`——COM 已以其它单元模式初始化。
const RPC_E_CHANGED_MODE: i32 = 0x8001_0106u32 as i32;

/// 打开系统目录选择器；返回选中路径 / 取消 / 不可用。
pub fn pick_folder() -> PickOutcome {
    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let initialized = hr.0 >= 0;
        let changed_mode = hr.0 == RPC_E_CHANGED_MODE;
        if !initialized && !changed_mode {
            return PickOutcome::Unavailable(format!("CoInitializeEx failed: {hr:?}"));
        }
        let outcome = show_dialog();
        if initialized {
            CoUninitialize();
        }
        outcome
    }
}

unsafe fn show_dialog() -> PickOutcome {
    let dialog: IFileOpenDialog =
        match CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) {
            Ok(dialog) => dialog,
            Err(err) => {
                return PickOutcome::Unavailable(format!("create folder dialog failed: {err}"))
            }
        };
    let options = dialog
        .GetOptions()
        .unwrap_or(FILEOPENDIALOGOPTIONS(0));
    let wanted =
        options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR;
    if let Err(err) = dialog.SetOptions(wanted) {
        return PickOutcome::Unavailable(format!("set dialog options failed: {err}"));
    }
    if let Err(err) = dialog.Show(None) {
        if err.code().0 == ERROR_CANCELLED_HRESULT {
            return PickOutcome::Cancelled;
        }
        return PickOutcome::Unavailable(format!("folder dialog failed: {err}"));
    }
    let item = match dialog.GetResult() {
        Ok(item) => item,
        Err(err) => return PickOutcome::Unavailable(format!("dialog result failed: {err}")),
    };
    let display: PWSTR = match item.GetDisplayName(SIGDN_FILESYSPATH) {
        Ok(display) => display,
        Err(err) => return PickOutcome::Unavailable(format!("display name failed: {err}")),
    };
    let text = display.to_string();
    CoTaskMemFree(Some(display.0 as *const c_void));
    match text {
        Ok(path) => PickOutcome::Picked(path),
        Err(_) => PickOutcome::Unavailable("display name is not valid UTF-16".to_string()),
    }
}
