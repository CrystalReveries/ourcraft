# PERFORMANCE.md — 性能实测与优化规则

> 铁律版在 [`AGENTS.md`](../AGENTS.md) §5；本文件记录**测量数据、实现细节、复测方法**。
> 机器基线：Intel UHD Graphics 620（ANGLE / D3D11）×1600×900 @1x，vite dev server。

## 0. 一句话总结

**场景里的 Mesh 数量就是帧预算。** 旧实现"每个可见方块一个 `InstancedMesh`"产生了
**99,789 个 Mesh 对象**，Babylon 每帧 `_evaluateActiveMeshes()` 遍历全部 mesh，
实测 **78.6 ms/帧**（≈12 fps）。改成 16×16 区块合并网格后 Mesh 数降到 ~380，
同样场景 **11.6 fps → 186 fps（16×）**，`_evaluateActiveMeshes` 降到 2.7 ms。

## 1. 当前基线（2026-11，区块合并网格之后）

只维护两个采样区域（见 §5）：`water`（整片海面）与 `village`（可见区块最多）。

| 场景 | avg FPS | p1 FPS | 帧时间 | CPU(render) | active mesh |
|---|---|---|---|---|---|
| water（水面 shader） | 157~199 | 61~79 | 5.0~6.4 ms | 4.2~5.4 ms | 56 |
| water-off（水面关闭，A/B 用） | 205~247 | 94~111 | 4.1~4.9 ms | 3.3~4.1 ms | 55 |
| village | 128~162 | 34~94 | 6.2~7.8 ms | 5.3~7.0 ms | 154~174 |

> 同一场景连续两次能差 15~30%（iGPU 降频/后台进程）。比较改动前后请跑两次取中位数。

优化前（同一台机器、同一脚本）：

| 场景 | avg FPS | 帧时间 | active mesh | `_evaluateActiveMeshes` |
|---|---|---|---|---|
| land-day（旧场景） | 11.6 | 86 ms | 26 045 | **78.6 ms** |
| village | 9.7 | 104 ms | 45 898 | — |
| lake（旧场景，水面 shader） | 11.6 | 86 ms | 20 039 | — |

## 2. 怎么定位到瓶颈的（方法论）

1. **先固定变量**：URL 加 `&noadapt`，脚本里 `setHwScale(1)`。否则自适应分辨率会把掉帧"抹平"。
2. **分辨率扫描**排除 GPU 填充率：`--hwscale=1/2/4` 帧率完全不变（10.9/11.8/11.6）⇒ 不是 fill-rate。
3. **数真实 draw call**：patch `gl.drawElements*` 计数，每帧只有 43 个 ⇒ 不是 draw call 数量问题。
4. **拆 CPU/GPU**：包住 `scene.render()` 计时，`cpuMs ≈ frameMs`（85.6/86）⇒ 主线程卡死。
5. **包住 `_evaluateActiveMeshes()`**：78.6 ms/帧 ⇒ 锁定"每帧遍历 10 万个 Mesh"。
6. **CDP CPU profile** 复核：`_renderForCamera` 自耗 49.5%（内联了 active mesh 遍历）。

> 教训：不要看 `engine._drawCalls`，那个计数器和真实 GL draw call 不是一回事（曾显示 4700+，实际 43）。

## 3. 已落地的优化（按收益排序）

### P0 区块合并网格（chunk meshing）——11.6 → 186 fps
`src/world.ts`

- 世界按 **16×16×SY** 切块（192×192 ⇒ 12×12 = 144 区块）。
- 每个区块最多 3 张静态网格，共享 3 个材质：
  | 通道 | 材质 | 内容 |
  |---|---|---|
  | `opaque` | `matTerrain`（图集，`freeze()`） | 所有普通立方体 |
  | `glass` | `matGlassChunk`（透明纹理） | 玻璃 |
  | `plant` | `matPlant`（alpha blend 图集） | 十字植物（草/花） |
- 几何由 `geometry.ts appendBoxFace()` / `world.ts appendPlant()` 累积；
  UV/绕序与 `buildBoxGeometry` **完全一致**（有 UT 保证：`appendBoxFace 与 buildBoxGeometry 等价`）。
- 只有"暴露的面"才写入：`opaqueAt(x,y,z)` 判断邻居是否遮挡。
  **世界底面外（y<0）视为不透明**，所以 y=0 的 36,864 块基岩不再产生无用几何；
  水平边界外也视为不透明（玩家永远在world内）。
- 网格创建后 `freezeWorldMatrix()` + `doNotSyncBoundingInfo = true`，
  几何更新后 `refreshBoundingInfo()`（视锥剔除按区块生效）。
- 仍然实例化的只有：红石元件（粉/火把/拉杆/灯，会换外观）、萤石（自发光材质）、生物、玩家模型。

### P0 世界编辑路径：只重建受影响区块
`updateInstancesAt()` → `rebuildChunksAt(x, z)`：

- 重建所在区块；若方块落在区块边界，再重建相邻区块（最多 3 个）。
- 实测挖/放 **avg 3.3~5.5 ms，max 12 ms**（一次性开销，不影响持续帧率；详见 §6）。
- 空区块时保留 Mesh 只 `setEnabled(false)`，避免反复创建/销毁。
- 内层循环用 `Uint8Array` 查表（`OPAQUE_T` 等）+ 固定体素索引偏移，避免访问 `DEFS[id].xxx`
  对象属性（约 20% 提升）。
- `npm run fps -- --edit` 会自动做 25 次挖/放并校验世界状态复原。

### P1 植物合并（1,385 → 0 个实例）
草/花原来是 14 种 master × 每株一个实例（1,385 个 Mesh）。现在写进区块的 `plant` 通道，
`plantTileFor()` 用坐标哈希选变体（同一位置外观稳定，不需要额外方块 id）。

### P1 纹理与材质
- **单张图集** 512×256（8×4 格，64px/格），程序化生成，`hasAlpha = false`。
  所有区块共享同一材质 ⇒ 无需多材质切换，也便于以后合批。
- `matTerrain.freeze()`：材质参数静态，跳过每帧脏检查。
- `anisotropicFilteringLevel = 1`：iGPU 上 8/16x 各向异性只烧带宽，画质肉眼无差。
- 玻璃/植物各自独立纹理（必须保留 alpha），**不要**为了省纹理把它们塞进不透明图集。

### P2 兜底
- 自适应分辨率：55 fps 以下 `setHardwareScalingLevel` 步进升到 1.7（≈60% 分辨率），70 fps 以上回落。
- `?water=flat|off` + `setWaterMode()`：低端机可一键关掉水面波浪。

## 4. 水面 shader 的结论（明确记录）

| 水面档位 | avg FPS（water 场景） | 说明 |
|---|---|---|
| `shader`（波动+菲涅尔+波光） | 157~165 | **保留** |
| `flat`（纯色 alpha） | 160 | 与 shader 持平/更慢，说明**不是 ALU 瓶颈** |
| `off` | 205~232 | 差值 = 帧时间的 24~32% |

- 优化前（CPU 瓶颈时代）三档差异在 ±1.5% 噪声内 ⇒ 当时的 12 fps 与水面无关。
- 现在 CPU 不再是瓶颈，水面开销显形，但成本来自**半透明整片海面的填充率/overdraw**，
  不是 shader 数学（flat 反而更慢）。150+ fps 远超 30 fps 目标，因此**保留波动**。
- 以后要进一步压：按区块拆分水面网格（让离屏水面被视锥剔除），或加 `backFaceCulling = true`
  （代价：水下抬头看不到水面）。

## 5. 复测方法（只采两个区域，够用即可）

```bash
npm run dev                      # 可选，脚本会自动拉起 vite
npm run fps                      # water + village 两个区域，2s warmup + 3s 采样
npm run fps -- --edit            # 附加：挖/放 25 次的耗时与正确性
npm run fps -- --burst           # 附加：快速建造压力（每帧 1 / 5 次编辑）下的帧率下限
npm run fps -- --diag            # GPU 型号、Mesh 数、GL draw call、_evaluateActiveMeshes 耗时
npm run fps -- --profile         # CDP CPU profile 热点（配合 --burst 看编辑开销构成）
npm run fps -- --scenario=village # 只跑一个区域（water / water-off / village）
npm run fps -- --shot=node_modules/.perf   # 每场景截图，用于视觉回归
npm run fps -- --json            # 额外打印原始 JSON
```

采样区域只有两个，故意不做全景覆盖：

| 区域 | URL | 为什么选它 |
|---|---|---|
| `water` | `?debug&day&noadapt&lake` | 整片海面 → 半透明填充率/overdraw 的最坏情况（另跑一次 `water-off` 做 A/B） |
| `village` | `?debug&day&noadapt&village` | 可见区块最多、几何最复杂、还有生物和透明物排序 |

脚本要点（`scripts/fps.mjs`）：

- `channel: "chrome"` ⇒ 用**本机已安装的 Chrome**（headed），不下载 Playwright 浏览器。
- 默认 `--disable-gpu-vsync --disable-frame-rate-limit`：测吞吐上限而不是 60Hz 上限；
  想验证"能不能稳住 60"时加 `--vsync`。
- 每场景 warmup 2 s 后采样 3 s **真实帧间隔**（`onAfterRenderObservable` 打时间戳），
  输出平均帧率、p1（最差 1% 帧）、`scene.render()` 的 JS 耗时。
- 页面通过 `window.__mc`（`main.ts` 里的调试钩子）切分辨率/水面档位/读写方块。
- **机器噪声很大**：同一场景连续两次可能差 15~30%（iGPU 降频/后台进程）。
  判定"是否变差"时以 `_evaluateActiveMeshes` 和 Mesh 数为主，帧率看多次中位数。

## 6. 挖/放方块会不会让"网格合并"失效？（实测结论：不会）

### 6.1 只重建被碰到的区块，不是全图
`breakBlock` / `placeBlock` → `updateInstancesAt(x,y,z)` → `rebuildChunksAt(x,z)`：

- 重建方块所在区块（16×16×64 = 16,384 体素）；
- 若方块落在区块边界，再重建相邻 1~2 个区块（最多 3 个）；
- 其余 141 个区块的网格、GPU buffer 完全不动。

所以"频繁挖方块导致合并失效"这个担心不成立 —— 合并的粒度是区块，不是整个世界。

### 6.2 单次编辑的开销（village 场景实测）

| 操作 | avg | p95 | max |
|---|---|---|---|
| break（含 1 次区块重建） | 4.9~5.5 ms | 6~8 ms | 12 ms |
| place（含 1 次区块重建） | 3.3~4.9 ms | 5~7 ms | 12 ms |

**这不是每帧开销**，只在真正编辑那一下发生一次。人类操作频率：

- 按住左键挖石头：1 块 / 0.3~3 s → 折算 1~3 ms/s，占帧预算 <0.5%；
- 快速右键连点放置：约 5~8 块/s → 约 30 ms/s ≈ 2%。

`--edit` 里 25 次挖/放后帧率不降（176 → 198/158 fps 区间内正常波动），验证完毕。

### 6.3 极端情况（`--burst`）：每帧都编辑

| 编辑强度 | 每帧重建次数 | 编辑耗时 | 帧时间 / 帧率 |
|---|---|---|---|
| 1 次/帧（≈128 次/秒） | 2 | 5.6~6.9 ms | 11.8 ms → **81~85 fps** |
| 5 次/帧（≈640 次/秒） | 10 | 15.3~19.2 ms | 19.7 ms → **42~51 fps** |

即"每帧都在挖"这种非人类操作才把 140+ fps 压到 40~80 fps。真正会遇到的场景是
**多人同步/爆炸/批量填充**，届时按下面的方案再优化。

### 6.4 编辑开销的构成（`--burst --profile`）

| 部分 | self time | 能否搬进 worker |
|---|---|---|
| `buildChunk`（扫 16k 体素 + 面剔除 + 发面） | **43%** | 能 |
| `appendBoxFace`（写顶点数组） | 3.7% | 能 |
| 顶点上传 `_createVertexBuffer` / `createBuffer` / `bufferData` / `_normalizeIndexData` | **≈7%** | **不能**（WebGL 上下文在主线程） |
| 其余（GC、V8、驱动、渲染） | 余下 | — |

已做的低成本优化：把 `DEFS[id].opaque / .special / .cross` 摊平成 `Uint8Array` 查表
（`OPAQUE_T` / `CHUNK_BLOCK_T` / `CROSS_T` / `GLASS_T`），并把相邻面判定改成
"体素索引 + 固定偏移"，内层循环不再调用函数、不再访问对象属性 —— 编辑开销降约 20%。
（顺带验证过：给透明材质加 `freeze()` **没有**收益，已回退，别再加。）

## 7. 要不要用 Web Worker + 双缓冲？（结论：现在不做，条件满足再上）

### 7.1 为什么现在不做
1. 只有 ~47% 的编辑开销能搬走（见 6.4）；剩下上传部分必须在主线程。
2. 人类编辑频率下行开销 ≈2% 帧预算（见 6.2），省不出可感知的帧率。
3. 代价不小：
   - `SharedArrayBuffer` 需要 COOP/COEP 响应头，**GitHub Pages 静态托管设不了**，
     只能给 worker 复制一份 2.36 MB 的 `world` 并逐条发变更消息；
   - 区块重建结果要到下一帧才可见（≥1 帧延迟），挖方块会"慢半拍"；
   - 需要版本号/失效队列，处理"重建期间又被改"、重生成世界、多人回滚等竞态。

### 7.2 真要做时的设计（已验证可行）
```
主线程                                   worker（1 个，专用）
world: Uint8Array(2.36MB)  ──复制一次──▶  自己的 world 副本
placeBlock/breakBlock      ──变更消息──▶  标记区块脏（合并同帧多次编辑）
                                          buildChunkGeometry()：扫体素 + 面剔除
                                          → {positions,normals,uvs,indices} 四个 TypedArray
                        ◀──transfer──    postMessage(…, [buffers]) 零拷贝
写入"背面"顶点缓冲 → 交换 → 下一帧可见
```
- **双缓冲指的是每个区块两套顶点缓冲**：一套正在渲染，一套接收新几何，
  写完再交换。目的不是提速，而是避免"重建到一半被渲染"导致闪一帧空/破面；
  前提是分配时给容量留头寸（用 `mesh.updateVerticesData` 而不是 `setVerticesData`，
  后者会重建 GPU buffer）。
- 线程数：1 个足够（编辑事件稀疏），不必按区块分池。
- 可见性延迟用"先在主线程隐藏/占位、几何回填后替换"来遮（可选）。

### 7.3 触发条件（满足任意一条再动手）
- 单次编辑 > 10 ms（例如区块尺寸放大到 32×32，或世界高度加倍）；
- 持续编辑速率 > 20 次/秒（多人同步、爆炸、批量填充 / 建筑机器人）；
- 帧时间预算被编辑挤压 > 15%（`--burst` 里 5 次/帧已经到 20 ms，说明阈值就在附近）。

## 8. 剩余瓶颈与后续方向

| 方向 | 现状 | 预期收益 |
|---|---|---|
| 水面按区块拆分 | 1 张整世界网格，无法按视锥剔除；`water` vs `water-off` 差 30~47% | 湖面场景 +10~20% |
| 生物渲染 | 每只生物 ~8 个 Mesh（未实例化），30 只 ≈ 240 Mesh | 生物多时明显；可换 thin instance |
| 村庄场景 p1 偏低 | 更多可见区块 + 生物 + 透明物排序 | 视锥/材质合批 |
| 区块网格分 LOD | 目前全分辨率 | 远距离三角面数 |
| Web Worker 几何构建 | 未做，见 §7（当前收益 ≈ 编辑开销的一半，而编辑只占 2%） | 极端编辑率 / 世界放大后再评估 |
| Web Worker 生成世界 | 生成在主线程（约几百 ms） | 只影响加载，不影响帧率 |

> 反面清单（不要再做）：逐方块 `createInstance`、每方块一个材质、按帧遍历全图体素、
> 在热路径 `new Vector3`、每帧 `texture.update()`、改成 `hasAlpha = true` 的图集、
> 给透明材质加 `freeze()`（实测无收益）、把区块重建改成整图重建。

## 9. 回归 checklist（提交前）

- [ ] `npx tsc --noEmit && npm test`
- [ ] `npm run fps -- --diag`：`scene.meshes` < ~500、`activeMeshes` < ~200、
      `_evaluateActiveMeshes` < ~3 ms
- [ ] `npm run fps`：water / village 与上次记录相比不低 10% 以上（连续跑两次取中位数，
      这台 iGPU 单次波动可达 15~30%）
- [ ] `npm run fps -- --edit --shot=node_modules/.perf`：挖/放 < ~8 ms、`restored=true`、
      截图里地形无破洞/无 UV 错位
- [ ] `npm run fps -- --burst`：1 次/帧编辑时仍 > 60 fps（超出人类操作上限的余量）
- [ ] 水面、玻璃、植物、红石灯外观与改动前一致
