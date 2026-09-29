// 休眠提供方：进程一启动即退出，制造「世界声明在、端点行缺失」的运行期隔离态。
// `restart.policy = never` 保证不重启，避免测试期反复起停。
process.exit(1)
