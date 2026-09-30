// 路径包含判定的共享小工具（源自 `sandbox` 的 fsop 路径口径）：Windows 大小写不敏感、分隔符归一、
// `\\?\` 前缀剥离。exec 的 cwd 校验需要与 fsop 同口径的工作区包含判定，故在本插件内保留一份。

use std::path::Path;

fn strip_extended(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    text
}

pub(crate) fn norm_key(path: &Path) -> String {
    let text = strip_extended(path).replace('\\', "/");
    if cfg!(windows) {
        text.to_lowercase()
    } else {
        text
    }
}

/// `target` 是否落在 `root` 内（含自身）；Windows 大小写不敏感、分隔符归一。
pub(crate) fn is_inside(target: &Path, root: &Path) -> bool {
    let target_key = norm_key(target);
    let root_key = norm_key(root);
    if target_key == root_key {
        return true;
    }
    let root_trimmed = root_key.trim_end_matches('/');
    target_key.starts_with(&format!("{root_trimmed}/"))
}

/// canonicalize 双方后判定包含；双方不可 canonicalize（如目录尚不存在）时回落到词法包含。
pub(crate) fn is_inside_resolved(target: &Path, root: &Path) -> bool {
    match (std::fs::canonicalize(target), std::fs::canonicalize(root)) {
        (Ok(target), Ok(root)) => is_inside(&target, &root),
        _ => is_inside(target, root),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_is_prefix_bounded() {
        assert!(is_inside(Path::new("/ws/a"), Path::new("/ws")));
        assert!(is_inside(Path::new("/ws"), Path::new("/ws")));
        assert!(!is_inside(Path::new("/ws-other"), Path::new("/ws")));
    }
}
