#![cfg(target_os = "linux")]
// seccomp-BPF syscall 过滤：BPF 程序在**父进程**编译（分配在 fork 前），子进程 `pre_exec` 里
// `PR_SET_NO_NEW_PRIVS` + `PR_SET_SECCOMP(FILTER)`（均异步信号安全）。
//
// 基础集合（宁可少禁）：禁 `mount` / `umount2` / `ptrace` / kexec / 内核模块 / `reboot` /
// `pivot_root` / `swapon` / `swapoff`。`caps.net == none` 时另加：`socket` 域仅放行 `AF_UNIX` /
// `AF_NETLINK`（NSS 的本地查询需要 netlink），挡住 `AF_INET` / `AF_INET6` / `AF_PACKET`，从而无外网。
//
// 只支持 x86_64（syscall 号与 AUDIT_ARCH 按架构不同，其他架构不声称 seccomp）；经典 BPF（无 libc）。

use std::path::Path;

use crate::linux::{prctl, PR_SET_SECCOMP};

const SECCOMP_MODE_FILTER: i64 = 2;
const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
const EPERM: u32 = 1;

const AUDIT_ARCH_X86_64: u32 = 0xC000_003E;

// 经典 BPF 指令编码。
const BPF_LD_W_ABS: u16 = 0x20;
const BPF_JEQ_K: u16 = 0x15;
const BPF_RET_K: u16 = 0x06;

// `struct seccomp_data` 字段偏移。
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARGS0: u32 = 16;

// x86_64 syscall 号（`asm/unistd_64.h`）。
const SYS_PTRACE: u32 = 101;
const SYS_PIVOT_ROOT: u32 = 155;
const SYS_MOUNT: u32 = 165;
const SYS_UMOUNT2: u32 = 166;
const SYS_SWAPON: u32 = 167;
const SYS_SWAPOFF: u32 = 168;
const SYS_REBOOT: u32 = 169;
const SYS_INIT_MODULE: u32 = 175;
const SYS_DELETE_MODULE: u32 = 176;
const SYS_KEXEC_LOAD: u32 = 246;
const SYS_FINIT_MODULE: u32 = 313;
const SYS_KEXEC_FILE_LOAD: u32 = 320;
const SYS_SOCKET: u32 = 41;

const AF_UNIX: u32 = 1;
const AF_NETLINK: u32 = 16;

/// 基础禁用集合。
const BASE_DENY: &[u32] = &[
    SYS_PTRACE,
    SYS_PIVOT_ROOT,
    SYS_MOUNT,
    SYS_UMOUNT2,
    SYS_SWAPON,
    SYS_SWAPOFF,
    SYS_REBOOT,
    SYS_INIT_MODULE,
    SYS_DELETE_MODULE,
    SYS_KEXEC_LOAD,
    SYS_FINIT_MODULE,
    SYS_KEXEC_FILE_LOAD,
];

#[repr(C)]
#[derive(Clone, Copy)]
pub struct SockFilter {
    code: u16,
    jt: u8,
    jf: u8,
    k: u32,
}

#[repr(C)]
struct SockFprog {
    len: u16,
    filter: *const SockFilter,
}

fn stmt(code: u16, k: u32) -> SockFilter {
    SockFilter { code, jt: 0, jf: 0, k }
}

fn jump(code: u16, jt: u8, jf: u8, k: u32) -> SockFilter {
    SockFilter { code, jt, jf, k }
}

/// seccomp 过滤是否可用：仅 x86_64，且内核暴露 seccomp 过滤动作。
pub fn available() -> bool {
    cfg!(target_arch = "x86_64") && Path::new("/proc/sys/kernel/seccomp/actions_avail").exists()
}

/// 编译过滤程序：`net_none` 为真时追加本地套接字白名单。
pub fn build_filter(net_none: bool) -> Vec<SockFilter> {
    let mut program = Vec::new();
    // 架构不符（复用同一过滤器）直接杀，避免用错 syscall 号表。
    program.push(stmt(BPF_LD_W_ABS, OFF_ARCH));
    program.push(jump(BPF_JEQ_K, 1, 0, AUDIT_ARCH_X86_64));
    program.push(stmt(BPF_RET_K, SECCOMP_RET_KILL_PROCESS));
    // 载入 syscall 号后逐项比对基础禁用集合（命中即回 EPERM）。
    program.push(stmt(BPF_LD_W_ABS, OFF_NR));
    for number in BASE_DENY {
        program.push(jump(BPF_JEQ_K, 0, 1, *number));
        program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    }
    if net_none {
        // socket 域检查：AF_UNIX / AF_NETLINK 放行，其余回 EPERM；非 socket 直接落 ALLOW。
        program.push(jump(BPF_JEQ_K, 0, 4, SYS_SOCKET));
        program.push(stmt(BPF_LD_W_ABS, OFF_ARGS0));
        program.push(jump(BPF_JEQ_K, 2, 0, AF_UNIX));
        program.push(jump(BPF_JEQ_K, 1, 0, AF_NETLINK));
        program.push(stmt(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
    }
    program.push(stmt(BPF_RET_K, SECCOMP_RET_ALLOW));
    program
}

/// 在子进程 `pre_exec` 内装载过滤器（先 `no_new_privs`，否则内核拒绝 FILTER 模式）。
pub fn apply(filter: &[SockFilter]) -> std::io::Result<()> {
    crate::linux::set_no_new_privs()?;
    let program = SockFprog {
        len: filter.len() as u16,
        filter: filter.as_ptr(),
    };
    // SAFETY: program 指向本栈上有效的指令数组；prctl 在返回前把过滤器拷进内核。
    let rc = unsafe {
        prctl(
            PR_SET_SECCOMP,
            SECCOMP_MODE_FILTER,
            &program as *const SockFprog as i64,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_ends_with_allow() {
        for net_none in [false, true] {
            let program = build_filter(net_none);
            let last = program.last().unwrap();
            assert_eq!(last.code, BPF_RET_K);
            assert_eq!(last.k, SECCOMP_RET_ALLOW);
        }
    }

    #[test]
    fn net_filter_checks_socket_domain() {
        let program = build_filter(true);
        assert!(program.iter().any(|item| item.code == BPF_JEQ_K && item.k == SYS_SOCKET));
        assert!(program.iter().any(|item| item.k == AF_UNIX));
        assert!(program.iter().any(|item| item.k == AF_NETLINK));
    }

    #[test]
    fn base_filter_has_no_socket_check() {
        let program = build_filter(false);
        assert!(!program.iter().any(|item| item.k == SYS_SOCKET));
    }
}
