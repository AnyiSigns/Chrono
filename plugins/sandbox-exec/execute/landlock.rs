#![cfg(target_os = "linux")]
// landlock fs 白名单：规则集在**父进程**构建（路径解析 / 分配都在 fork 前完成），子进程 `pre_exec`
// 只做 `no_new_privs` + `landlock_restrict_self`（均为异步信号安全的 syscall），避免 fork 后分配。
//
// 语义：按当前档把「读 / 写」限制到 `workspace_root` 子树。系统只读目录（运行时 / 动态库 / 设备 /
// 伪文件系统）另加只读规则，否则动态链接的解释器根本起不来。**不**处理 EXECUTE 位：避免目录遍历
// 被逐级拦截，执行权限不纳入白名单（可执行但不可读的文件不在本层防御范围，README 如实标注）。
//
// syscall 手写 `extern "C"`（不引 libc）；编号取 Linux 通用表（x86_64 / aarch64 同值）。

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::{AsRawFd, FromRawFd, RawFd};
use std::path::Path;
use std::sync::OnceLock;

use crate::linux::{self, syscall, O_CLOEXEC, O_PATH};
use crate::tiers::FsScope;

const SYS_LANDLOCK_CREATE_RULESET: i64 = 444;
const SYS_LANDLOCK_ADD_RULE: i64 = 445;
const SYS_LANDLOCK_RESTRICT_SELF: i64 = 446;

/// `landlock_create_ruleset` 的 `flags`：只查 ABI 版本。
const CREATE_RULESET_VERSION: i64 = 1;
/// `landlock_add_rule` 的规则类型。
const RULE_TYPE_PATH_BENEATH: i64 = 1;

// `LANDLOCK_ACCESS_FS_*` 位（linux/landlock.h）。
const ACCESS_FS_WRITE_FILE: u64 = 1 << 1;
const ACCESS_FS_READ_FILE: u64 = 1 << 2;
const ACCESS_FS_READ_DIR: u64 = 1 << 3;
const ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
const ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;
const ACCESS_FS_MAKE_CHAR: u64 = 1 << 6;
const ACCESS_FS_MAKE_DIR: u64 = 1 << 7;
const ACCESS_FS_MAKE_REG: u64 = 1 << 8;
const ACCESS_FS_MAKE_SOCK: u64 = 1 << 9;
const ACCESS_FS_MAKE_FIFO: u64 = 1 << 10;
const ACCESS_FS_MAKE_BLOCK: u64 = 1 << 11;
const ACCESS_FS_MAKE_SYM: u64 = 1 << 12;
const ACCESS_FS_REFER: u64 = 1 << 13;
const ACCESS_FS_TRUNCATE: u64 = 1 << 14;

/// 运行命令所必需的系统只读目录：解释器 / 动态库 / 配置缓存 / 设备 / 伪文件系统。
/// 只给读位；这些目录不进写规则，故仍不可写。
const SYSTEM_READ_PATHS: &[&str] = &[
    "/usr", "/bin", "/sbin", "/lib", "/lib64", "/lib32", "/libx32", "/etc", "/opt", "/dev",
    "/proc", "/sys", "/run",
];

/// 工作区外**允许写**的少量系统文件：`/dev/null` 是重定向刚需（`cmd 2>/dev/null`），其余一律不可写。
const SYSTEM_WRITE_PATHS: &[&str] = &["/dev/null"];

/// `landlock_ruleset_attr`（只用 FS 位；新内核多出的 net / scoped 字段按需截断 size 传入）。
#[repr(C)]
struct RulesetAttr {
    handled_access_fs: u64,
}

/// `landlock_path_beneath_attr`（内核声明为 packed，必须无填充）。
#[repr(C, packed)]
struct PathBeneathAttr {
    allowed_access: u64,
    parent_fd: i32,
}

/// 内核 landlock ABI 版本；`None` 表示内核未启用 landlock（ENOSYS / EOPNOTSUPP）。
pub fn abi() -> Option<i32> {
    static ABI: OnceLock<Option<i32>> = OnceLock::new();
    *ABI.get_or_init(|| {
        // SAFETY: 版本查询（attr=NULL, size=0, flags=VERSION）只读返回版本号或 -errno。
        let rc = unsafe {
            syscall(SYS_LANDLOCK_CREATE_RULESET, 0i64, 0i64, CREATE_RULESET_VERSION)
        };
        if rc >= 1 {
            Some(rc as i32)
        } else {
            None
        }
    })
}

/// 只读访问位（不含 EXECUTE，见模块头）。
fn read_bits() -> u64 {
    ACCESS_FS_READ_FILE | ACCESS_FS_READ_DIR
}

/// 写访问位；`REFER` / `TRUNCATE` 随 ABI 递增，低版本内核不认。
fn write_bits(abi: i32) -> u64 {
    let mut bits = ACCESS_FS_WRITE_FILE
        | ACCESS_FS_REMOVE_DIR
        | ACCESS_FS_REMOVE_FILE
        | ACCESS_FS_MAKE_CHAR
        | ACCESS_FS_MAKE_DIR
        | ACCESS_FS_MAKE_REG
        | ACCESS_FS_MAKE_SOCK
        | ACCESS_FS_MAKE_FIFO
        | ACCESS_FS_MAKE_BLOCK
        | ACCESS_FS_MAKE_SYM;
    if abi >= 2 {
        bits |= ACCESS_FS_REFER;
    }
    if abi >= 3 {
        bits |= ACCESS_FS_TRUNCATE;
    }
    bits
}

/// 文件（非目录）适用的写位：`landlock_add_rule` 对文件路径拒绝目录专属位（MAKE_* / REMOVE_DIR）。
fn file_write_bits(abi: i32) -> u64 {
    let mut bits = ACCESS_FS_WRITE_FILE;
    if abi >= 3 {
        bits |= ACCESS_FS_TRUNCATE;
    }
    bits
}

fn open_path(path: &Path) -> io::Result<File> {
    // O_PATH：仅取 inode 句柄，不触发读权限；CLOEXEC：别泄漏给被执行的程序。
    OpenOptions::new()
        .read(true)
        .custom_flags(O_PATH | O_CLOEXEC)
        .open(path)
}

fn create_ruleset(handled_access_fs: u64) -> io::Result<File> {
    let attr = RulesetAttr { handled_access_fs };
    // SAFETY: 传入本栈有效结构；size 与实际结构一致，flags=0。
    let fd = unsafe {
        syscall(
            SYS_LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr as i64,
            std::mem::size_of::<RulesetAttr>() as i64,
            0i64,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: fd 由内核新建、归本进程所有，交给 File 管理生命周期。
    let file = unsafe { File::from_raw_fd(fd as RawFd) };
    linux::set_cloexec(file.as_raw_fd())?;
    Ok(file)
}

fn add_path_rule(ruleset_fd: RawFd, path: &Path, allowed_access: u64) -> io::Result<()> {
    let parent = open_path(path)?;
    let attr = PathBeneathAttr {
        allowed_access,
        parent_fd: parent.as_raw_fd(),
    };
    // SAFETY: attr 指向本栈结构，parent_fd 为有效 O_PATH 句柄；规则在 add_rule 内被拷贝。
    let rc = unsafe {
        syscall(
            SYS_LANDLOCK_ADD_RULE,
            ruleset_fd as i64,
            RULE_TYPE_PATH_BENEATH,
            &attr as *const PathBeneathAttr as i64,
            0i64,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// 构建规则集；返回 `None` 表示本档无需 fs 白名单（读 / 写都 `Full`）或内核不支持。
/// `Err` 只用于规则集创建本身失败（调用方据此回退为不施加 landlock，并如实标注）。
pub fn build_ruleset(
    workspace_root: Option<&Path>,
    fs_read: FsScope,
    fs_write: FsScope,
) -> io::Result<Option<File>> {
    let restrict_read = fs_read != FsScope::Full;
    let restrict_write = fs_write != FsScope::Full;
    if !restrict_read && !restrict_write {
        return Ok(None);
    }
    let Some(abi) = abi() else {
        return Ok(None);
    };
    let read = read_bits();
    let write = write_bits(abi);
    let mut handled = 0;
    if restrict_read {
        handled |= read;
    }
    if restrict_write {
        handled |= write;
    }
    let ruleset = create_ruleset(handled)?;
    let fd = ruleset.as_raw_fd();
    if restrict_read {
        for path in SYSTEM_READ_PATHS {
            // 系统目录按发行版不同可能缺失，缺哪个跳哪个，不影响其余规则。
            let _ = add_path_rule(fd, Path::new(path), read);
        }
        if fs_read == FsScope::Workspace {
            if let Some(root) = workspace_root {
                let _ = add_path_rule(fd, root, read);
            }
        }
    }
    if restrict_write {
        for path in SYSTEM_WRITE_PATHS {
            // 只写白名单文件（如 /dev/null）；文件路径只能用文件专属位，否则 add_rule 返回 EINVAL。
            let _ = add_path_rule(fd, Path::new(path), file_write_bits(abi));
        }
        if fs_write == FsScope::Workspace {
            if let Some(root) = workspace_root {
                // 同一路径可叠加多条规则，放行位取并集：写规则同时给读位，免得写进工作区却读不回。
                let allowed = if restrict_read { read | write } else { write };
                let _ = add_path_rule(fd, root, allowed);
            }
            // 无 workspace_root → 无任何可写路径（fail-closed）。
        }
    }
    Ok(Some(ruleset))
}

/// 在子进程 `pre_exec` 内生效：先 `no_new_privs` 再 `restrict_self`。失败以 errno 返回，由 exec 中止。
pub fn restrict_self(ruleset_fd: RawFd) -> io::Result<()> {
    linux::set_no_new_privs()?;
    // SAFETY: ruleset_fd 为父进程建好的有效规则集 fd；flags=0。
    let rc = unsafe { syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd as i64, 0i64) };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrestricted_scope_builds_no_ruleset() {
        let ruleset = build_ruleset(None, FsScope::Full, FsScope::Full).unwrap();
        assert!(ruleset.is_none());
    }

    #[test]
    fn workspace_scope_builds_ruleset_when_supported() {
        if abi().is_none() {
            return;
        }
        let root = std::env::temp_dir();
        let ruleset = build_ruleset(Some(&root), FsScope::Workspace, FsScope::Workspace).unwrap();
        assert!(ruleset.is_some());
    }
}
