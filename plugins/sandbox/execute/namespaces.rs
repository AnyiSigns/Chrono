#![cfg(target_os = "linux")]
// 命名空间隔离：**user + mount**，以及 `caps.net == none` 时的 **net**。在 `pre_exec` 内 `unshare`，
// 随后写 uid / gid 映射（user ns 必需），并把 `/` 的挂载传播改为私有。
//
// **不含 pid namespace**：进入新 pid ns 必须在 `pre_exec` 里再 `fork` 一次，直接子进程会变成
// 转发者，从而破坏 `RLIMIT_CPU` 的 `SIGXCPU` / cgroup OOM 的 `SIGKILL` 信号归类（PID 1 忽略无处理
// 程序的信号）。本层优先保证资源强制与判定准确，pid 视图隔离**如实缺席**。
//
// 组合可用性由一次 `fork` 探针（`available`）在运行态验证；不可用即不施加并如实缺席。

use std::sync::OnceLock;

use crate::linux;

/// 一次执行的命名空间计划：`net` 视档位决定；uid / gid 映射在父进程预格式化（子进程只写字节）。
pub struct Plan {
    pub net: bool,
    pub uid_map: Vec<u8>,
    pub gid_map: Vec<u8>,
}

/// 在父进程构造计划（分配都在 fork 前完成）。
pub fn build(net: bool) -> Plan {
    Plan {
        net,
        uid_map: format!("0 {} 1\n", linux::host_uid()).into_bytes(),
        gid_map: format!("0 {} 1\n", linux::host_gid()).into_bytes(),
    }
}

fn flags(plan: &Plan) -> u64 {
    let mut flags = linux::CLONE_NEWUSER | linux::CLONE_NEWNS;
    if plan.net {
        flags |= linux::CLONE_NEWNET;
    }
    flags
}

/// 在子进程 `pre_exec` 内施加（unshare + 映射 + 私有挂载传播）；失败以 errno 返回、中止 exec。
pub fn apply(plan: &Plan) -> std::io::Result<()> {
    linux::unshare(flags(plan))?;
    // user ns 里 uid/gid 初始无映射；先禁 setgroups 再写 map（不接受时忽略 setgroups 一步）。
    let _ = linux::write_file_raw(b"/proc/self/setgroups\0", b"deny\n");
    linux::write_file_raw(b"/proc/self/uid_map\0", &plan.uid_map)?;
    linux::write_file_raw(b"/proc/self/gid_map\0", &plan.gid_map)?;
    linux::make_mounts_private()?;
    Ok(())
}

/// 运行态探针：fork 一个子进程实际执行一次完整组合（含 net），退出码为 0 即可用；结果进程内缓存。
pub fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let plan = build(true);
        match linux::fork() {
            Ok(0) => {
                let ok = apply(&plan).is_ok();
                linux::exit_now(if ok { 0 } else { 1 });
            }
            Ok(pid) => linux::wait_exit_code(pid) == 0,
            Err(_) => false,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_carries_uid_mapping() {
        let plan = build(false);
        assert_eq!(plan.uid_map, format!("0 {} 1\n", linux::host_uid()).into_bytes());
        assert!(!plan.net);
        assert!(build(true).net);
    }
}
