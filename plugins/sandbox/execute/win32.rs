// win32 原生隔离：Job Object（进程树 / 内存 / CPU 时间 / 活跃进程数上限）。
// 超时 / 超限 = TerminateJobObject（杀整树）；子进程以 CREATE_SUSPENDED 起、挂 job 后再 ResumeThread。
// 若宿主 / 测试进程本身处于不允许 breakaway 的 job，AssignProcessToJobObject 会失败，
// 此时回落 `taskkill /T /F`（树杀仍成立，但内存 / CPU / 进程数上限不强制——诚实登记为已知限制）。

#![cfg(windows)]

use std::ffi::c_void;
use std::io;
use std::mem::size_of;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT,
    JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_JOB_TIME, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOB_OBJECT_LIMIT_PROCESS_TIME,
};
use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

/// Job 句柄：Drop 时 CloseHandle（`KILL_ON_JOB_CLOSE` 保证残留子进程一并终止）。
pub struct JobHandle {
    handle: HANDLE,
}

/// 运行中 job 的观测值。
#[derive(Clone, Copy, Debug, Default)]
pub struct JobStats {
    pub active_processes: u32,
    pub user_time_100ns: i64,
    pub peak_job_memory: u64,
}

fn os_error(err: windows::core::Error) -> io::Error {
    io::Error::new(io::ErrorKind::Other, format!("{err}"))
}

impl JobHandle {
    /// 建 job 并设上限；`0` 表示该维度不限制。
    pub fn create(mem_bytes: u64, cpu_ms: u64, procs_max: u32) -> io::Result<Self> {
        // SAFETY: 无安全描述符、无名对象；返回的句柄由 Self 拥有并在 Drop 关闭。
        let handle = unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(os_error)?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        let mut mask = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0;
        if mem_bytes > 0 {
            mask |= JOB_OBJECT_LIMIT_PROCESS_MEMORY.0 | JOB_OBJECT_LIMIT_JOB_MEMORY.0;
            limits.ProcessMemoryLimit = mem_bytes as usize;
            limits.JobMemoryLimit = mem_bytes as usize;
        }
        if cpu_ms > 0 {
            let ticks = (cpu_ms as i64).saturating_mul(10_000);
            mask |= JOB_OBJECT_LIMIT_PROCESS_TIME.0 | JOB_OBJECT_LIMIT_JOB_TIME.0;
            limits.BasicLimitInformation.PerProcessUserTimeLimit = ticks;
            limits.BasicLimitInformation.PerJobUserTimeLimit = ticks;
        }
        if procs_max > 0 {
            mask |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS.0;
            limits.BasicLimitInformation.ActiveProcessLimit = procs_max;
        }
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT(mask);
        let size = size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        // SAFETY: handle 有效；limits 与声明长度、信息类匹配，调用期间存活。
        let applied = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                size,
            )
        };
        if let Err(err) = applied {
            // SAFETY: handle 为刚创建、尚未移交给 Self 的有效句柄，只关闭一次。
            unsafe {
                let _ = CloseHandle(handle);
            }
            return Err(os_error(err));
        }
        Ok(Self { handle })
    }

    /// 把已创建（挂起）的进程挂到 job。
    pub fn assign(&self, process: HANDLE) -> io::Result<()> {
        // SAFETY: self.handle 有效；process 为调用方持有的有效进程句柄。
        unsafe { AssignProcessToJobObject(self.handle, process) }.map_err(os_error)
    }

    /// 杀整树。
    pub fn terminate(&self, exit_code: u32) {
        // SAFETY: self.handle 有效；终止 job 不涉及 Rust 内存所有权。
        unsafe {
            let _ = TerminateJobObject(self.handle, exit_code);
        }
    }

    /// 读取 job 观测：活跃进程数 / 用户态 CPU 时间 / 峰值提交内存。
    pub fn stats(&self) -> JobStats {
        let mut stats = JobStats::default();
        // SAFETY: handle 有效；输出缓冲与信息类、长度一一匹配，仅写入局部变量。
        unsafe {
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            let mut returned = 0u32;
            let ok = QueryInformationJobObject(
                Some(self.handle),
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                Some(&mut returned),
            );
            if ok.is_ok() {
                stats.active_processes = accounting.ActiveProcesses;
                stats.user_time_100ns = accounting.TotalUserTime;
            }
            let mut extended = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            let ok = QueryInformationJobObject(
                Some(self.handle),
                JobObjectExtendedLimitInformation,
                &mut extended as *mut _ as *mut c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                Some(&mut returned),
            );
            if ok.is_ok() {
                stats.peak_job_memory = extended.PeakJobMemoryUsed as u64;
            }
        }
        stats
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        // SAFETY: self.handle 由 create 成功返回、仅在此关闭一次。
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// 恢复以 `CREATE_SUSPENDED` 创建的进程：枚举该 pid 的线程并 ResumeThread。
pub fn resume_process(pid: u32) -> io::Result<()> {
    // SAFETY: 快照句柄在函数末尾关闭；entry 的 dwSize 已按要求初始化；
    // Thread32First/Next 只写 entry；OpenThread 返回的线程句柄立即关闭。
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(os_error)?;
        let mut entry = THREADENTRY32::default();
        entry.dwSize = size_of::<THREADENTRY32>() as u32;
        let mut resumed = false;
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) {
                        let _ = ResumeThread(thread);
                        let _ = CloseHandle(thread);
                        resumed = true;
                    }
                }
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        if resumed {
            Ok(())
        } else {
            Err(io::Error::new(io::ErrorKind::Other, "no thread resumed"))
        }
    }
}

/// 无 job 时的树杀回落：`taskkill /T /F`。
pub fn kill_tree(pid: u32) -> io::Result<()> {
    let status = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::new(io::ErrorKind::Other, "taskkill failed"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use windows::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};

    #[test]
    fn job_creates_and_reports() {
        let job = JobHandle::create(0, 0, 4).unwrap();
        let stats = job.stats();
        assert_eq!(stats.active_processes, 0);
    }

    #[test]
    fn suspended_process_attaches_to_job() {
        let job = JobHandle::create(0, 0, 4).unwrap();
        let mut command = std::process::Command::new("cmd.exe");
        command
            .args(["/c", "ping -n 5 127.0.0.1 > nul"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        command.creation_flags(CREATE_SUSPENDED.0 | CREATE_NO_WINDOW.0);
        let mut child = command.spawn().unwrap();
        let handle = HANDLE(child.as_raw_handle() as *mut c_void);
        job.assign(handle).unwrap();
        resume_process(child.id()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(job.stats().active_processes >= 1);
        job.terminate(1);
        let _ = child.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert_eq!(job.stats().active_processes, 0);
    }
}
