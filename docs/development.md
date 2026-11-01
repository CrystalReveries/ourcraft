# 开发指南

## 环境
- Node.js ≥ 20（当前验证 24.15）
- 依赖：`@babylonjs/core ^9.30.0`、`vite ^6`、`typescript ^5.6`、`tsx`（测试）
- WSL 下 Firefox/Chrome 访问 `http://localhost:5173`

## 命令
```bash
npm install
npm run dev            # 开发服务器 (host 0.0.0.0:5173)
npm test               # 几何单元测试 (tsx + node:test)
npx tsc --noEmit       # 类型检查 (strict)
npm run build          # 类型检查 + 生产构建到 dist/
npm run preview        # 预览构建产物
```

## 验证流程（每次改动至少跑前两步）
1. `npx tsc --noEmit` — 必须零错误
2. `npm test` — 几何不变量回归
3. 视觉验证：无头浏览器截图 + 多模态检查
   ```bash
   google-chrome --headless=new --no-sandbox --enable-unsafe-swiftshader \
     --hide-scrollbars --window-size=1280,720 --virtual-time-budget=15000 \
     --screenshot=/tmp/shot.png "http://localhost:5173/?debug=1&up&day"
   ```
   调试参数：`?debug`（隐藏遮罩+固定视角）、`&up`（抬高 8 格）、`&day`/`&night`（时间）
4. 交互回归：挖掘/放置、红石开关灯、生物追击、面板与命令

> 无头 SwiftShader 下 FPS 很低是正常的（软件渲染），不要据此判断性能；性能用真机观察 FPS 计数器。

## 新增方块 checklist
1. `src/config.ts`：`B` 加 ID → `T` 加图集 tile（8 列，行 = floor(tile/8)）→ `DEFS[id]` 填全字段
2. `src/world.ts` 的 `makeAtlas()`：绘制该 tile（透明块不要画满，或准备独立纹理）
3. **普通方块无需注册**：`chunkMeshes` 的 `opaque`/`glass`/`plant` 通道会自动包含它
   （判定见 `world.ts` 的 `CHUNK_BLOCK_T` 查表）；只有 `special`（红石元件）或需要独立材质（如萤石自发光）
   才在 `generateWorld()` 的 `masters.set(...)` 里加一行，走实例路径
4. 需要可放置：加入 `HOTBAR`
5. 特殊行为（红石/发光/不透明）：在 `DEFS` 标记 `special` / `opaque` / `solid`，必要时在 `masterFor` 增加变体
6. 跑 `npm test` + `npm run fps -- --diag`（确认 Mesh 数没暴涨）+ 截图验证

## 新增生物 checklist
1. `src/mobs.ts` 的 `MOB_TYPES` 加条目（尺寸/血量/速度/伤害/掉落/敌对）
2. `initMobs()` 会自动为每个类型合并身体+头部网格并生成主网格
3. 敌对 AI、寻路、物理、命中检测自动生效；碰撞箱由 `w/h` 决定
4. 需要贴图/多部件时参见 `docs/roadmap.md` 的生物细节方案

## 新增工具档位
`src/config.ts` 的 `PICK_TIERS` / `SWORD_TIERS`（价格/速度/伤害），商店与自动装备自动适配。

## 代码约定
- `strict: true` + `noUnusedLocals`；避免 `any`
- 热循环（每帧）禁止分配对象：复用模块级临时 `Vector3/Color3`
- **静态方块禁止逐方块建 Mesh/实例**：走区块合并网格（`buildChunk`），
  实例只留给会变外观/会动的对象。Mesh 总数是硬预算，见 `AGENTS.md` §5
- 静态网格创建后必须 `freezeWorldMatrix()`；材质共享并 `freeze()`
- 世界变更统一走 `placeBlock/breakBlock`（内部处理区块重建、红石、边界、上限）
- 手写几何必须满足绕序约定并有 UT 覆盖
- 模块边界：`geometry.ts`/`config.ts` 保持无 Babylon 场景依赖（未来服务器复用）

## Git 规范
- 分支：`main` 保持可运行；功能分支 `feat/<scope>`，修复 `fix/<scope>`
- 提交信息：Conventional Commits（`feat:`, `fix:`, `perf:`, `docs:`, `refactor:`, `test:`）
- 提交前：`npx tsc --noEmit && npm test`
- 不提交 `node_modules/`、`dist/`、日志与本地截图

## WSL 工具链注意事项
- `/d`（Windows 盘）上 inotify 不可靠 → `vite.config.ts` 已开启 `watch.usePolling`
- IDE 安全删除钩子会拦截 Vite 重建 `node_modules/.vite`（>500 文件）→ 已改用独立 `cacheDir: node_modules/.vite-cache`；若再次遇到，删除缓存目录或换新 cacheDir 名字
- 无头截图需要 `--enable-unsafe-swiftshader`（无 GPU 的 WSL）
