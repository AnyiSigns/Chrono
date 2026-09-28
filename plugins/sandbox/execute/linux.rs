// Linux 原生执行所需的 syscall 绑定：手写 `extern "C"`，不引 libc——
// 与 sandbox「零第三方运行时依赖 / 离线可构建」的口径一致（Windows 侧同样只依赖 windows crate）。
//
// 常量取 Linux ABI 固定值（glibc / musl 同值）；`rlim_t` 在 64 位 Linux 为 unsigned long，
// 故本模块只声明 64 位口径（当前 Linux 目标为 x86_64 / aarch64）。
#![cfg(target_os = "linux")]

/// Linux `__rlimit_resource_t`。
pub type RlimitResource = u32;

/// Linux `struct rlimit`（64 位 `rlim_t`）。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Rlimit {
    pub rlim_cur: u64,
    pub rlim_max: u64,
}

pub const RLIMIT_CPU: RlimitResource = 0;
pub const RLIMIT_NPROC: RlimitResource = 6;
pub const RLIMIT_AS: RlimitResource = 9;
pub const SIGKILL: i32 = 9;
pub const SIGXCPU: i32 = 24;

/// `open(2)` 标志（x86_64 / aarch64 同值）。
pub const O_CLOEXEC: i32 = 0o2000000;
/// 只取路径句柄、不读内容（landlock 规则用）。
pub const O_PATH: i32 = 0o10000000;

/// `fcntl(2)` 命令。
pub const F_SETFD: i32 = 2;
pub const FD_CLOEXEC: i32 = 1;

/// `prctl(2)` 选项。
pub const PR_SET_NO_NEW_PRIVS: i32 = 38;
pub const PR_SET_SECCOMP: i32 = 22;

extern "C" {
    fn setrlimit(resource: RlimitResource, rlim: *const Rlimit) -> i32;
    fn kill(pid: i32, sig: i32) -> i32;
    fn write(fd: i32, buf: *const u8, count: usize) -> isize;
    #[link_name = "fork"]
    fn c_fork() -> i32;
    fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    fn _exit(code: i32) -> !;
    fn getuid() -> u32;
    fn getgid() -> u32;
    fn open(path: *const i8, flags: i32, ...) -> i32;
    fn close(fd: i32) -> i32;
    fn mount(
        source: *const i8,
        target: *const i8,
        filesystem_type: *const i8,
        flags: u64,
        data: *const i8,
    ) -> i32;
    pub fn syscall(number: i64, ...) -> i64;
    pub fn prctl(option: i32, ...) -> i32;
    fn fcntl(fd: i32, cmd: i32, ...) -> i32;
}

/// `unshare(2)` 的 `CLONE_*` 命名空间标志。
pub const CLONE_NEWNS: u64 = 0x0002_0000;
pub const CLONE_NEWUSER: u64 = 0x1000_0000;
pub const CLONE_NEWNET: u64 = 0x4000_0000;
/// `mount(2)` 标志。
pub const MS_REC: u64 = 1 << 14;
pub const MS_PRIVATE: u64 = 1 << 18;

const SYS_UNSHARE: i64 = 272;
const O_WRONLY: i32 = 1;

/// 设置 rlimit（软 / 硬分别给值）。
pub fn set_rlimit(resource: RlimitResource, soft: u64, hard: u64) -> std::io::Result<()> {
    let limit = Rlimit {
        rlim_cur: soft,
        rlim_max: hard,
    };
    // SAFETY: 传入本进程有效结构指针；setrlimit 只读该结构。
    let rc = unsafe { setrlimit(resource, &limit) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// 杀整个进程组（负 pid 即「组内所有进程」）。
pub fn kill_group(pgid: i32) {
    // SAFETY: 负 pid 表示进程组；SIGKILL 无副作用返回。
    unsafe {
        let _ = kill(-pgid, SIGKILL);
    }
}

/// 设置 `FD_CLOEXEC`（landlock 规则集 fd 用完即随 exec 关闭，不泄漏给被执行的程序）。
pub fn set_cloexec(fd: i32) -> std::io::Result<()> {
    // SAFETY: fcntl 只读改本进程 fd 描述符标志。
    let rc = unsafe { fcntl(fd, F_SETFD, FD_CLOEXEC) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// 禁止子进程经 setuid / 文件权能获得新特权（landlock_restrict_self 的前置条件）。
pub fn set_no_new_privs() -> std::io::Result<()> {
    // SAFETY: prctl 仅置本进程单比特标志。
    let rc = unsafe { prctl(PR_SET_NO_NEW_PRIVS, 1i64, 0i64, 0i64, 0i64) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// 向 fd 写完整缓冲（`pre_exec` 迁移 cgroup 用；write 为异步信号安全 syscall）。
pub fn write_all(fd: i32, bytes: &[u8]) -> std::io::Result<()> {
    let mut written = 0;
    while written < bytes.len() {
        // SAFETY: buf 指针与剩余长度都有效；write 只读该缓冲。
        let rc = unsafe { write(fd, bytes[written..].as_ptr(), bytes.len() - written) };
        if rc <= 0 {
            return Err(std::io::Error::last_os_error());
        }
        written += rc as usize;
    }
    Ok(())
}

/// 本进程真实 uid / gid（新 user namespace 的映射源）。
pub fn host_uid() -> u32 {
    // SAFETY: getuid 无参数、只读。
    unsafe { getuid() }
}

pub fn host_gid() -> u32 {
    // SAFETY: getgid 无参数、只读。
    unsafe { getgid() }
}

/// `unshare(2)`：把本进程移入新的命名空间。
pub fn unshare(flags: u64) -> std::io::Result<()> {
    // SAFETY: 只传常量 flag，无指针参数。
    let rc = unsafe { syscall(SYS_UNSHARE, flags as i64) };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// 把 `/` 的挂载传播改为私有（防止新 mount namespace 内的挂载泄漏回宿主）。
pub fn make_mounts_private() -> std::io::Result<()> {
    // SAFETY: 传空 source / fstype / data，target 为静态 NUL 结尾字符串。
    let rc = unsafe {
        mount(
            std::ptr::null(),
            b"/\0".as_ptr() as *const i8,
            std::ptr::null(),
            MS_REC | MS_PRIVATE,
            std::ptr::null(),
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// 以只写方式打开 `path`（须为 NUL 结尾字节串）并写完整内容（`pre_exec` 里写 uid/gid_map）。
pub fn write_file_raw(path: &[u8], data: &[u8]) -> std::io::Result<()> {
    // SAFETY: path 为调用方给的 NUL 结尾静态字节串。
    let fd = unsafe { open(path.as_ptr() as *const i8, O_WRONLY) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    let result = write_all(fd, data);
    // SAFETY: fd 由本函数打开，关闭一次。
    unsafe {
        let _ = close(fd);
    }
    result
}

/// `fork(2)`；子进程返回 0，父进程返回子 pid。
pub fn fork() -> std::io::Result<i32> {
    // SAFETY: fork 无参数。
    let pid = unsafe { c_fork() };
    if pid < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(pid)
    }
}

/// 等到 `pid` 退出，返回退出码（信号终止返回 `128 + signal`）。
pub fn wait_exit_code(pid: i32) -> i32 {
    let mut status = 0;
    // SAFETY: status 为有效栈变量指针。
    unsafe {
        let _ = waitpid(pid, &mut status, 0);
    }
    if status & 0x7f == 0 {
        (status >> 8) & 0xff
    } else {
        128 + (status & 0x7f)
    }
}

/// 立即终止当前（子）进程，不跑任何析构（`pre_exec` 探针用）。
pub fn exit_now(code: i32) -> ! {
    // SAFETY: _exit 立即结束进程。
    unsafe { _exit(code) }
}
