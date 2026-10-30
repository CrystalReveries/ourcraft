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
                  ├─ updateInstancesAt(3x3x3 邻域实例增删)
                  ├─ updateRedstoneRegistry + (邻域有元件才) recomputeRedstone
                  └─ 返回 BlockDef(硬度/金币)
        → 渲染: InstancedMesh(冻结世界矩阵)
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
| `world: Uint8Array(64*48*64)` | 体素 ID；索引 `x + z*SX + y*SX*SZ` |
| `instances: Map<"x,y,z", InstancedMesh>` | 每个可见方块一个实例 |
| `masters: Map<blockId, Mesh>` | 每种方块的主网格（隐藏） |
| `redstoneCells: Map<key, special>` | 红石元件注册表（增量维护，避免全图扫描） |
| `dustOn / lampLit / leverOn: Set<key>` | 红石状态位 |
| `mobs: Mob[]` | 生物列表（根节点 + 实例 + 碰撞箱 + 路径） |

## 渲染策略
- **只渲染可见方块**：邻接面全被不透明方块遮挡则不创建实例（`faceVisible`）
- **实例化 + 冻结矩阵**：静态方块 `freezeWorldMatrix()`，避免每帧重算
- **程序化图集**：512×256（8×4 格，64px/格），`DynamicTexture`，无外部资源
- **透明分离**：图集 `hasAlpha=false`；玻璃用独立 64×64 透明纹理 + `backFaceCulling=false`
- **雾效**：线性雾 40→110，颜色随昼夜/天气变化
- **渲染分辨率**：连续 3 次采样 FPS<24 时按 25% 步进降档（`setHardwareScalingLevel`）

## 性能预算（单人 64×48×64 世界）
| 操作 | 优化前 | 优化后 |
|---|---|---|
| 每次挖/放方块 | 全图 19.7 万格扫描 | 注册表遍历（通常 <100 项），且无红石邻域时直接跳过 |
| 每帧方块矩阵 | ~7000 次矩阵合成 | 0（冻结） |
| 鼠标移动 | 场景拾取射线 | 无（`skipPointerMovePicking`） |
| 主循环分配 | 每帧多个 Vector/Color 对象 | 0（复用临时对象） |

详见 [../PERFORMANCE.md](../PERFORMANCE.md)。

## 扩展点
- **新方块**：`config.ts` 加 ID/DEFS/图集 tile → `world.ts` 注册主网格（若为特殊元件再写 master）→ 需要时加进 `HOTBAR`
- **新生物**：`mobs.ts` 的 `MOB_TYPES` 加类型（尺寸/血量/速度/伤害）→ 自动获得网格、物理、寻路
- **新工具档位**：`config.ts` 的 `PICK_TIERS` / `SWORD_TIERS`
- **新结构**：`world.ts` 的 `buildVillage` 同级新增 builder，在 `generateWorld` 中调用
- **新命令**：`main.ts` `execCommand` 的 switch
