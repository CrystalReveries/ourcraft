# AGENTS.md — Babylon MiniCraft 长期开发指南

> 给 AI/人类开发者的入口文档。详细设计见 [`docs/`](./docs/README.md)。

## 1. 项目使命
做一个基于 **Babylon.js 9 + TypeScript + Vite** 的 Minecraft 风格体素沙盒，
**长期目标是局域网多人（<10 人）**。
当前状态：**单人可玩版本 v1 已完成**（世界生成/建造挖掘/红石/生物/昼夜天气/经济/管理系统）。

下一步（按顺序）：
1. **生物细节与贴图**：多部件模型 + 程序化贴图 + 行走动画（见 `docs/roadmap.md` Phase 2）
2. **多人模式**：Node 权威服务器 + WebSocket，LAN <10 人（见 `docs/multiplayer.md`）

## 2. 命令
```bash
npm install
npm run dev          # Vite dev server, 0.0.0.0:5173
npm run server       # LAN 权威服务器 ws://0.0.0.0:8787（上限 10 人，仅需昵称）
npm test             # 几何单元测试 (tsx + node:test)
npx tsc --noEmit     # 类型检查（strict，必须零错误）
npm run build        # 构建 dist/
```
视觉回归（无 GPU 的 WSL 可用）：
```bash
google-chrome --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --hide-scrollbars --window-size=1280,720 --virtual-time-budget=15000 \
  --screenshot=/tmp/shot.png "http://localhost:5173/?debug=1&up&day"
```
调试参数：`?debug` 隐藏遮罩+固定视角，`&up` 抬高视角，`&day`/`&night` 设定时间。
（SwiftShader 下 FPS 很低属正常，不代表真实性能。）

## 3. 架构地图
```
index.html          页面 + HUD/面板 DOM 骨架
src/config.ts       方块 DEFS / tile 索引 / 工具档位 / 世界常量   ← 纯数据
src/geometry.ts     单位立方体几何（绕序/UV），纯函数            ← 有 UT 覆盖
src/items.ts        物品定义 / 背包 / 合成配方 / 工具查询        ← 纯逻辑
src/world.ts        体素数据、地形/矿脉/树/村庄生成、
                    图集与网格、实例管理、红石、DDA 射线
src/mobs.ts         6 种生物：多部件模型/贴图/动画/物理/A*/战斗
src/systems.ts      昼夜循环、天空光照插值、雨粒子
src/net.ts          LAN 客户端（WebSocket / 差量 / 远端玩家）
src/main.ts         引擎/相机/玩家/输入/背包合成饥饿 UI/面板/命令
server/index.ts     LAN 权威服务器（ws，上限 10 人，方块校验广播）
tests/geometry.test.ts
docs/               架构、玩法、功能清单、开发、经验、路线图、多人方案
```

### 关键数据结构
- `world: Uint8Array(64*48*64)`，索引 `x + z*SX + y*SX*SZ`
- `instances: Map<"x,y,z", InstancedMesh>`：只存可见方块实例
- `masters: Map<blockId, Mesh>`：每种方块的隐藏主网格
- `redstoneCells: Map<key, special>`：红石元件注册表（增量维护）
- `mobs: Mob[]`：根节点 + 实例 + 碰撞箱 + A* 路径

## 4. 不可破坏的不变量（违反必出 bug）
1. **方块绕序**：`(p1-p0)×(p2-p0)·法线 < 0`（Babylon 前向面约定）。
   否则外表面被剔除，看起来像"开口盒子"。`npm test` 会拦截。
2. **图集 `hasAlpha = false`**；玻璃用独立透明纹理。否则所有方块进入透明管线，出现透视缝隙。
3. **玩家脚底 Y**：地表方块 `y` 的顶面是 `y+1`，出生点/传送后脚底需 > `y+1`，否则埋进方块内部。
4. **实例创建后立即 `freezeWorldMatrix()`**（静态方块），否则每帧矩阵重算导致掉帧。
5. **世界变更只走 `placeBlock` / `breakBlock`**（内部处理边界、高度上限、实例、红石）。
6. **热循环零分配**：复用模块级临时 `Vector3/Color3`，禁止在每帧路径 `new`。
7. **方向约定**：`yaw += movementX`（右转）、`pitch += movementY`（下看），Babylon 左手系。

## 5. 扩展规范（简明版，详见 `docs/development.md`）
- **新方块**：`config.ts`(B/T/DEFS) → `world.ts makeAtlas()` 画 tile → `generateWorld()` 的 `masters.set` 列表 → 可选 `HOTBAR` → `npm test` + 截图
- **新生物**：`mobs.ts MOB_TYPES` 加条目即可获得网格/物理/寻路/命中；细节模型见 roadmap
- **新工具**：`config.ts` 的 `PICK_TIERS` / `SWORD_TIERS`
- **新结构**：`world.ts` 加 builder，在 `generateWorld` 调用
- **新命令**：`main.ts execCommand` switch
- 破坏性/大范围改动前先读 `docs/lessons.md`，避免重复踩坑

## 6. 代码约定
- TypeScript `strict`，禁用 `any`；模块边界清晰（`config.ts`/`geometry.ts` 不得依赖 Babylon 场景）
- 渲染与逻辑尽量分离（多人的前置条件：`shared/` 纯逻辑可被 Node 服务器复用）
- 注释用中文，命名用英文；单文件超过 ~600 行考虑拆分
- 提交前必须 `npx tsc --noEmit && npm test`

## 7. Git 规范
- `main` 始终可运行；功能用 `feat/<scope>`，修复用 `fix/<scope>`
- Conventional Commits：`feat: / fix: / perf: / refactor: / docs: / test:`
- 不提交 `node_modules/`、`dist/`、日志、本地截图（见 `.gitignore`）
- 每个可玩里程碑打 tag（如 `v1.0-singleplayer`）

## 8. 已知工具链问题（WSL）
- `/d` 为 Windows 盘，inotify 不可靠 → 已开 `server.watch.usePolling`
- IDE 安全删除钩子会拦截批量删除 → 已使用独立 `cacheDir: node_modules/.vite-cache`
- 无头截图需 `--enable-unsafe-swiftshader`

## 9. 文档索引
- [docs/Features.md](./docs/Features.md) — **功能清单与状态跟踪（改功能先更新这里）**
- [docs/README.md](./docs/README.md) — 总览
- [docs/architecture.md](./docs/architecture.md) — 模块/数据流/渲染/性能
- [docs/gameplay.md](./docs/gameplay.md) — 操作/方块/生物/经济/命令
- [docs/development.md](./docs/development.md) — 环境/测试/扩展 checklist/Git
- [docs/lessons.md](./docs/lessons.md) — 踩坑与经验
- [docs/roadmap.md](./docs/roadmap.md) — 生物细节、多人、后续扩展
- [docs/multiplayer.md](./docs/multiplayer.md) — 多人权威服务器与协议设计
- [docs/PERFORMANCE.md](./PERFORMANCE.md) — 性能优化记录
