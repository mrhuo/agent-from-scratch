import { defineConfig } from "vitest/config";

// 把 vitest 的缓存与转换中间产物放到项目本地（node_modules/.vitest），
// 规避受限沙箱对系统临时目录的写权限抖动（偶发 EPERM 会导致个别测试文件被静默跳过）。
// 同时关闭文件级并行，让收集更稳定、结果可复现。
export default defineConfig({
  test: {
    cache: { dir: "./node_modules/.vitest" },
    fileParallelism: false,
    pool: "forks",
    include: ["tests/**/*.test.ts"],
  },
});
