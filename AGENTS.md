# AGENTS.md — babylonjs-ourcraft: Minecraft in Babylon.js

1. USE English for code and comment in code, keep UI and docs/*.md as Chinese
2. github-cr is just host alias to github.com for the second github user to ssh
3. once push git action will deploy the game as static page host at: https://crystalreveries.github.io/ourcraft/
  test the game is working before push to github
4. Performannce is critical, design with performane in mind, webworker allowed,  target PFS >30:  
5. use headed Chrome + playwright to profile at local machine, http://127.0.0.1:5173, 
5. disable profiling on github pages static host publish

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
npm run fps          # 自动化 FPS 基准：本机 Chrome(headed) + Playwright
```
视觉回归（无 GPU 的 WSL 可用）：
```bash
google-chrome --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --hide-scrollbars --window-size=1280,720 --virtual-time-budget=15000 \
  --screenshot=/tmp/shot.png "http://localhost:5173/?debug=1&up&day"
```
调试参数：`?debug` 隐藏遮罩+固定视角（同时不自动弹教程），`&up` 抬高视角，`&day`/`&night` 设定时间，
`&nofog` 关雾，`&village` 飞到第一座村庄上空，`&lake` 站到最近浅水岸边，
`&at=x,y,z` / `&look=yaw,pitch` 精确摆机位（正 pitch = 向下看），
`&noadapt` 关闭自适应分辨率（性能测量必加），`&water=shader|flat|off` 切换水面档位。
（SwiftShader 下 FPS 很低属正常，不代表真实性能。）

性能测量（首选，比截图更可靠）。**采样只保留两个区域**，不做全景覆盖：
`water`（整片海面 → 透明/填充率最坏情况）与 `village`（可见区块最多）。
```bash
npm run fps                                   # water + village，输出 avg/p1/CPU
npm run fps -- --diag                         # GPU 型号 + GL draw call + _evaluateActiveMeshes 耗时
npm run fps -- --edit                         # 挖/放 25 次：耗时 + 区块重建正确性
npm run fps -- --burst                        # 快速建造压力（每帧 1/5 次编辑）的帧率下限
npm run fps -- --profile                      # CDP CPU profile 热点（配 --burst 看编辑开销构成）
npm run fps -- --scenario=village --shot=node_modules/.perf   # 单区域 + 截图
```
机器噪声大（同一场景两次差 15~30%），判定"变差"以 `_evaluateActiveMeshes` / Mesh 数为主，
帧率跑两次取中位数。

## 3. 架构地图
```
index.html          页面 + HUD/面板 DOM 骨架
src/config.ts       方块 DEFS / tile 索引 / 工具档位 / 世界常量   ← 纯数据
src/geometry.ts     单位立方体几何（绕序/UV），纯函数            ← 有 UT 覆盖
src/items.ts        物品定义 / 背包 / 合成配方 / 工具查询        ← 纯逻辑
src/world.ts        体素数据、地形/矿脉/树/村庄生成、
                    图集、区块合并网格、红石、DDA 射线
src/mobs.ts         6 种生物：多部件模型/贴图/动画/物理/A*/战斗
src/systems.ts      昼夜循环、天空光照插值、雨粒子
src/net.ts          LAN 客户端（WebSocket / 差量 / 远端玩家）
src/main.ts         引擎/相机/玩家/输入/背包合成饥饿 UI/面板/命令
server/index.ts     LAN 权威服务器（ws，上限 10 人，方块校验广播）
tests/geometry.test.ts
docs/               架构、玩法、功能清单、开发、经验、路线图、多人方案
```

### 关键数据结构
- `world: Uint8Array(SX*SY*SZ)`（192×64×192 ≈ 236 万体素），索引 `x + z*SX + y*SX*SZ`
- `chunkMeshes: Map<chunkIndex, {opaque, glass, plant}>`：**性能核心**。
  16×16×SY 一个区块，普通方块/玻璃/十字植物各合并成一张静态网格；
  方块变化只重建所在区块（+ 边界上的邻居区块），约 2~4 ms/次，不影响帧率
- `instances: Map<"x,y,z", InstancedMesh>`：**仅**红石元件（粉/火把/拉杆/灯）与萤石
- `masters: Map<blockId, Mesh>`：实例方块的隐藏主网格（当前只有萤石）
- `redstoneCells: Map<key, special>`：红石元件注册表（增量维护）
- `mobs: Mob[]`：根节点 + 实例 + 碰撞箱 + A* 路径

## 4. 不可破坏的不变量（违反必出 bug）
1. **方块绕序**：`(p1-p0)×(p2-p0)·法线 < 0`（Babylon 前向面约定）。
   否则外表面被剔除，看起来像"开口盒子"。`npm test` 会拦截。
2. **图集 `hasAlpha = false`**；玻璃用独立透明纹理。否则所有方块进入透明管线，出现透视缝隙。
3. **玩家脚底 Y**：地表方块 `y` 的顶面是 `y+1`，出生点/传送后脚底需 > `y+1`，否则埋进方块内部。
4. **静态几何创建后立即 `freezeWorldMatrix()`**，否则每帧矩阵重算导致掉帧。
5. **世界变更只走 `placeBlock` / `breakBlock`**（内部处理边界、高度上限、区块重建、红石）。
6. **热循环零分配**：复用模块级临时 `Vector3/Color3`，禁止在每帧路径 `new`。
7. **方向约定**：`yaw += movementX`（右转）、`pitch += movementY`（下看），Babylon 左手系。

## 5. 渲染与性能铁律（违反必掉帧，详见 `docs/PERFORMANCE.md`）
> 一句话：**场景里的 Mesh 数量就是帧预算**。Babylon 每帧 `_evaluateActiveMeshes()`
> 要遍历 `scene.meshes` 里的**每一个**对象（LOD map / `isReady` / 矩阵 / 视锥）。
> 实测 10 万个 Mesh 时这一步就吃掉 78 ms/帧（12 fps）；降到 ~400 个后 2~3 ms（180 fps+）。

1. **一个方块 ≠ 一个 Mesh**。静态方块必须走区块合并网格
   （`world.ts buildChunk()`，16×16×SY/区块，`appendBoxFace`/`appendPlant` 累积面）。
   新增方块只要 `config.ts` 里 `DEFS` 有定义就会自动进区块网格，**不要**再 `createInstance`。
2. **Mesh 数量硬预算**：`scene.meshes` < 约 500；`getActiveMeshes()` < 约 200。
   `npm run fps -- --diag` 直接打印这两个数，改动后必须复核。
3. **只有"不能用静态几何表达"的东西才允许实例化**：红石元件（会换外观）、萤石（独立自发光材质）、
   生物（会动）。植物已合并进区块网格的 plant 通道，不要再拆回去。
4. **材质必须共享并冻结**：所有区块网格复用 `matTerrain` / `matGlassChunk` / `matPlant`；
   材质参数改完后 `material.freeze()`。禁止每个方块/每个网格 new 一个材质。
5. **纹理只有一张图集**：512×256 程序化生成，`hasAlpha = false`，`anisotropicFilteringLevel = 1`。
   禁止逐方块贴图、禁止运行时反复 `texture.update()`（只在生成时 `update()` 一次）。
   需要"压缩"时优先减少 tile 尺寸/纹理数量，而不是引入 KTX/DDS 依赖。
6. **顶点预算来自"面剔除"**：区块网格只写**暴露的面**（`opaqueAt` 判断邻居）。
   世界底面外视为不透明（y=0 基岩层不会被生成 3.6 万个无用面）。
7. **世界编辑只重建单区块**：`updateInstancesAt()` → `rebuildChunksAt()`，
   只重建本区块 + 边界邻居（挖/放 3~5 ms，一次性开销，非每帧）。
   **不要**改成"整图重建"；也不要把这一层搬进 Web Worker：
   实测编辑只占人类操作下 ~2% 帧预算，worker 只能省掉约一半（顶点上传必须在主线程），
   却要复制一份世界数据并引入 ≥1 帧延迟 —— 判定条件与设计方案见 `docs/PERFORMANCE.md` §7。
8. **热路径查表**：区块重建内层循环禁止访问 `DEFS[id].xxx` 对象属性，
   用 `OPAQUE_T / CHUNK_BLOCK_T / CROSS_T / GLASS_T` 这些 `Uint8Array` 查表 + 固定索引偏移。
9. **热路径 O(可见物体)**：主循环里只能遍历生物/粒子等少量对象，禁止遍历世界体素或全部 Mesh。
10. **改性能必须量测**：先 `npm run fps -- --diag` 找瓶颈（CPU vs GPU、Mesh 数、eval 耗时），
   改完再跑一次并记录到 `docs/PERFORMANCE.md`。禁止凭感觉"优化"。
11. **自适应分辨率兜底保留**：`hwScale` 55fps 以下降分辨率、70fps 以上回升；
    性能测量时用 `?noadapt` 关掉它，否则会掩盖真实数字。

## 6. 扩展规范（简明版，详见 `docs/development.md`）
- **新方块**：`config.ts`(B/T/DEFS) → `world.ts makeAtlas()` 画 tile → 可选 `HOTBAR` → `npm test` + 截图。
  普通方块**自动**进区块网格，无需注册 master；只有 `special`（红石元件）或需要独立材质时
  才在 `generateWorld()` 的 `masters.set(...)` 里加一行
- **新生物**：`mobs.ts MOB_TYPES` 加条目即可获得网格/物理/寻路/命中；细节模型见 roadmap
- **新工具**：`config.ts` 的 `PICK_TIERS` / `SWORD_TIERS`
- **新结构**：`world.ts` 加 builder，在 `generateWorld` 调用
- **新命令**：`main.ts execCommand` switch
- 破坏性/大范围改动前先读 `docs/lessons.md`，避免重复踩坑

## 7. 代码约定
- TypeScript `strict`，禁用 `any`；模块边界清晰（`config.ts`/`geometry.ts` 不得依赖 Babylon 场景）
- 渲染与逻辑尽量分离（多人的前置条件：`shared/` 纯逻辑可被 Node 服务器复用）
- 注释用中文，命名用英文；单文件超过 ~600 行考虑拆分
- 提交前必须 `npx tsc --noEmit && npm test`

## 8. Git 规范
- `main` 始终可运行；功能用 `feat/<scope>`，修复用 `fix/<scope>`
- Conventional Commits：`feat: / fix: / perf: / refactor: / docs: / test:`
- 不提交 `node_modules/`、`dist/`、日志、本地截图（见 `.gitignore`）
- 每个可玩里程碑打 tag（如 `v1.0-singleplayer`）

## 9. 已知工具链问题（WSL）
- `/d` 为 Windows 盘，inotify 不可靠 → 已开 `server.watch.usePolling`
- IDE 安全删除钩子会拦截批量删除 → 已使用独立 `cacheDir: node_modules/.vite-cache`
- 无头截图需 `--enable-unsafe-swiftshader`

## 10. 文档索引
- [docs/Features.md](./docs/Features.md) — **功能清单与状态跟踪（改功能先更新这里）**
- [docs/README.md](./docs/README.md) — 总览
- [docs/architecture.md](./docs/architecture.md) — 模块/数据流/渲染/性能
- [docs/gameplay.md](./docs/gameplay.md) — 操作/方块/生物/经济/命令
- [docs/development.md](./docs/development.md) — 环境/测试/扩展 checklist/Git
- [docs/lessons.md](./docs/lessons.md) — 踩坑与经验
- [docs/roadmap.md](./docs/roadmap.md) — 生物细节、多人、后续扩展
- [docs/multiplayer.md](./docs/multiplayer.md) — 多人权威服务器与协议设计
- [docs/PERFORMANCE.md](./PERFORMANCE.md) — 性能优化记录
