import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    // 集成测试大量 spawn 服务子进程：逐文件串行跑，避免在少核机器上把彼此的
    // 握手 / 重启 / 调用超时挤爆（表现为随机超时，而非实现失败）。
    poolOptions: { forks: { minForks: 1, maxForks: 1 } },
    // 冷启动 + 多进程场景下默认 5s 偏紧
    testTimeout: 20000,
  },
})
