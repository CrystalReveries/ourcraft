import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { defineConfig } from "vite";

// 依赖缓存目录按 lockfile 哈希轮换：
// 该环境（WSL + Windows 盘 + IDE 安全删除钩子）禁止批量删除 >500 文件，
// 而 Vite 在锁文件变化时会尝试删除旧的 deps 缓存。用新目录名即可完全避免删除操作。
function cacheDirByLockfile(): string {
  try {
    if (existsSync("package-lock.json")) {
      const hash = createHash("sha1").update(readFileSync("package-lock.json")).digest("hex").slice(0, 8);
      return `node_modules/.vite-${hash}`;
    }
  } catch {
    /* 忽略，回退到默认目录 */
  }
  return "node_modules/.vite";
}

export default defineConfig({
  base: "./",
  cacheDir: cacheDirByLockfile(),
  server: {
    host: true, // 监听 0.0.0.0，WSL 下 Windows 浏览器可访问
    port: 5173,
    open: false,
    watch: {
      usePolling: true,   // /d 挂载盘上 inotify 不可靠，改用轮询保证热更新
      interval: 300,
    },
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 6000,
  },
});
