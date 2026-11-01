# 架构设计

## 分层
```
┌───────────────────────────────────────────────┐
│ main.ts  引擎/相机/玩家物理/输入/HUD/管理面板/命令 │
└───────────────┬───────────────────────────────┘
                │ 调用
   ┌────────────┼──────────────┬───────────────┐
   ▼            ▼              ▼               ▼
world.ts     mobs.ts        systems.ts     config.ts / geometry.ts
体素+生成    生物AI/寻路     昼夜/天气       定义/纯几何
   │
   ▼
Babylon 场景（实例化网格、图集纹理）
```

## 模块职责
| 模块 | 职责 | 是否依赖 Babylon |
|---|---|---|
| `src/config.ts` | 方块 DEFS、tile 索引、工具档位、世界常量 | 否 |
| `src/geometry.ts` | 单位立方体几何（绕序/UV），纯函数 | 否（仅返回数组） |
| `src/items.ts` | 物品定义、36 格背包、合成配方与工具查询 | 否 |
| `src/world.ts` | 体素存取、地形/矿脉/树/村庄生成、图集与网格构建、实例管理、红石、DDA 射线 | 是 |
| `src/mobs.ts` | 6 种生物：多部件模型/贴图/动画、AABB 物理、A* 寻路、战斗 | 是 |
| `src/systems.ts` | 昼夜循环、天空/光照插值、雨粒子 | 是 |
| `src/net.ts` | LAN 客户端：WebSocket、世界差量、远端玩家渲染/插值 | 是 |
| `src/main.ts` | 玩家、输入、背包/合成/饥饿 UI、挖掘/战斗、面板、命令 | 是 |
| `server/index.ts` | LAN 权威服务器：房间/校验/广播/差量世界（Node + ws） | 否（Node） |
| `tests/geometry.test.ts` | 几何绕序/UV/结构回归测试 | 否 |

> 单人版本中 world.ts 混合了数据与渲染。**多人阶段必须拆分**：`world/data.ts`（纯体素+生成+红石规则）与 `world/render.ts`（实例/材质），以便 Node 服务器复用同一份权威逻辑。

## 数据流
```
键盘鼠标 → 玩家状态(pos/vel/yaw/pitch)
        → 物理: 分轴 AABB 碰撞(world.boxCollides)
        → 交互: DDA raycastBlock → 命中方块/上一格
        → 变更: placeBlock / breakBlock
                  ├─ 更新 Uint8Array 体素
                  ├─ updateInstancesAt → rebuildChunksAt(重建所在区块 + 边界邻居)
                  ├─ updateRedstoneRegistry + (邻域有元件才) recomputeRedstone
                  └─ 返回 BlockDef(硬度/金币)
        → 渲染: 区块合并网格(每 16×16×SY 一张，冻结世界矩阵)
```

主循环（`scene.onBeforeRenderObservable`）：
1. 输入 → 速度/重力 → 分轴移动
2. 相机位姿同步
3. 按住左键的挖掘进度（速度由镐档位决定）
4. 生物 AI + 夜间刷怪
5. 环境（时间/天气/雨粒子跟随）
6. HUD（FPS + 自适应分辨率降档）

## 关键数据结构
| 结构 | 说明 |
|---|---|
| `world: Uint8Array(SX*SY*SZ)` | 体素 ID（192×64×192）；索引 `x + z*SX + y*SX*SZ` |
| `chunkMeshes: Map<index, {opaque, glass, plant}>` | 区块合并网格（16×16×SY/区块），普通方块/玻璃/植物各一张 |
| `instances: Map<"x,y,z", InstancedMesh>` | 仅红石元件与萤石等特殊方块 |
| `masters: Map<blockId, Mesh>` | 实例方块的隐藏主网格 |
| `redstoneCells: Map<key, special>` | 红石元件注册表（增量维护，避免全图扫描） |
| `dustOn / lampLit / leverOn: Set<key>` | 红石状态位 |
| `mobs: Mob[]` | 生物列表（根节点 + 实例 + 碰撞箱 + 路径） |

## 渲染策略
- **区块合并网格（核心）**：16×16×SY 一个区块，把区块内所有方块面累积成静态网格；
  普通方块/玻璃/十字植物各一张，共享 3 个材质。方块变化只重建所在区块（+ 边界邻居）
- **逐面剔除**：`opaqueAt(x,y,z)` 判断邻居是否遮挡；世界底面外视为不透明，
  因此 y=0 基岩层不产生几何。只写暴露的面
- **实例只给"非常规"方块**：红石元件（会换外观）、萤石（自发光材质）、生物、玩家
- **冻结矩阵**：所有静态网格 `freezeWorldMatrix()`，避免每帧重算；
  区块网格另加 `doNotSyncBoundingInfo`，几何更新后手动 `refreshBoundingInfo()`
- **程序化图集**：512×256（8×4 格，64px/格），`DynamicTexture`，无外部资源；
  单张图集 + 单一材质，`anisotropicFilteringLevel = 1`，`material.freeze()`
- **透明分离**：图集 `hasAlpha=false`；玻璃用独立 64×64 透明纹理 + `backFaceCulling=false`
- **植物图集**：独立 256×256（4×4 格）带 alpha 图集，4 种高草 + 10 种花共享同一 `StandardMaterial`；
  变体按坐标哈希选 tile，合并进区块的 `plant` 通道（同一位置外观稳定）
- **水面**：单张网格（只铺上方暴露于空气的水面顶面）+ `ShaderMaterial`（顶点波动 / 菲涅尔 / 波光），
  半透明混合；`DEFS[B.WATER].opaque=false` 让水下方块面照常生成
- **朝下面补光**：`hemi.groundColor` 设为浅灰蓝，避免树冠底/屋檐/洞顶纯黑
- **雾效**：线性雾 70→190，颜色随昼夜/天气变化
- **渲染分辨率**：以 60fps 为目标，连续 2 次采样 <55fps 时按 15% 降档（最低 60%），>70fps 时逐步升回 100%

## 性能预算（单人 192×64×192 世界）
| 指标 | 优化前 | 优化后（实测） |
|---|---|---|
| 场景 Mesh 总数 | 99,910（每方块一个实例） | ~380 |
| `_evaluateActiveMeshes` | 78.6 ms/帧 | 2.7 ms/帧 |
| land-day 帧率 | 11.6 fps | 186 fps |
| 每次挖/放方块 | 全图扫描 + 实例增删 | 重建单区块 ≈2.6~4 ms |
| 鼠标移动 | 场景拾取射线 | 无（`skipPointerMovePicking`） |
| 主循环分配 | 每帧多个 Vector/Color 对象 | 0（复用临时对象） |

详见 [../PERFORMANCE.md](../PERFORMANCE.md)。
复测：`npm run fps -- --diag`（本机 Chrome + Playwright，固定分辨率）。

## 扩展点
- **新方块**：`config.ts` 加 ID/DEFS/图集 tile → `world.ts` 注册主网格（若为特殊元件再写 master）→ 需要时加进 `HOTBAR`
- **新生物**：`mobs.ts` 的 `MOB_TYPES` 加类型（尺寸/血量/速度/伤害）→ 自动获得网格、物理、寻路
- **新工具档位**：`config.ts` 的 `PICK_TIERS` / `SWORD_TIERS`
- **新结构**：`world.ts` 的 `buildVillage` 同级新增 builder，在 `generateWorld` 中调用
- **新命令**：`main.ts` `execCommand` 的 switch
