# 经验与踩坑记录

记录已经发生过的真实问题、根因、修复方式与防复发手段。

## 1. 方块看起来像"开口盒子"（最典型）
**现象**：方块外表面不可见，只能看到方块内壁/透过去，像没有封口的盒子。

**根因（两层叠加）**
1. **几何绕序反向**：Babylon（左手系）前向面要求
   `(p1-p0)×(p2-p0)·法线 < 0`。我们用 `t×b = n` 生成的索引是 `> 0`，
   于是所有外表面被背面剔除，只有从方块内部才能看到面。
2. **出生点埋进地面**：`spawnPoint.y = y + 0.1`，而 `y` 是地表方块**所在格**，
   其顶面在 `y+1`。玩家脚底在 `y+0.1` → 整个人嵌在方块里，镜头看到的正是内壁，
   视觉上放大成"开口盒子"。

**修复**
- 索引改为顺时针：`indices.push(base, base+2, base+1, base, base+3, base+2)`
- 出生点改为 `y + 1.05`
- 几何抽离为 `src/geometry.ts` 纯函数，加 UT 断言 `cross·normal < 0`

**防复发**
- `npm test` 会检测绕序；改几何必须跑测试
- 用截图调试参数（`?debug&up`）做视觉回归，不要只靠"看着像没问题"

## 2. 透明图集导致深度排序漏洞
**现象**：方块边缘出现透视/闪烁，像缺面。

**根因**：为支持玻璃，给整张图集设了 `hasAlpha = true`，
使**所有**方块材质进入透明渲染管线；透明物体排序不精确 → 出现透视缝隙。

**修复**：图集 `hasAlpha = false`；玻璃单独一张 64×64 透明纹理与材质。

**防复发**：只有真正需要透过的方块使用 alpha 材质，且使用独立纹理。

## 3. 性能：三个隐性开销
| 开销 | 具体问题 | 修复 |
|---|---|---|
| 红石重算 | 每次挖/放方块全图扫描 19.7 万格（5~20ms 卡顿） | `redstoneCells` 注册表增量维护 + 3×3×3 邻域判定后才重算 |
| 实例矩阵 | ~7000 个静态实例每帧重算 world matrix | `freezeWorldMatrix()`（含主网格与红石换色重建路径） |
| 指针拾取 | 鼠标移动触发 Babylon 场景拾取 | `scene.skipPointerMovePicking = true`（自研 DDA 射线） |
| 每帧分配 | 主循环/环境系统 new Vector3/Color 造成 GC | 模块级临时对象 + `set()/copyToRef/LerpToRef` |

**经验**：先测量再优化；实例化场景中"冻结矩阵"和"避免整图扫描"通常是最大收益。

## 4. Babylon 视角方向约定
Babylon 左手系：`rotation.y` 增大 → 向右转；`rotation.x` 增大 → 向下看。
因此标准 FPS 控制是：
```ts
player.yaw += e.movementX * sens;   // 鼠标右移 → 右转
player.pitch += e.movementY * sens; // 鼠标下移 → 下看
```
最初两个符号都写反，表现为"控制反转"。

## 5. WSL + Windows 盘（/d）热更新失效
**现象**：改了 TS 文件，浏览器仍是旧代码；只有 index.html 偶尔刷新。

**根因**：`/d` 挂载的是 drvfs，inotify 不可靠，chokidar 收不到变更。

**修复**：`vite.config.ts` → `server.watch.usePolling: true, interval: 300`。

## 6. IDE 安全删除钩子阻断 Vite 重建依赖缓存
**现象**：`npm run dev` 报
`[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] ... node_modules/.vite/deps`。

**根因**：lockfile 变更触发 Vite 重新预构建，需要批量删除 >500 个缓存文件，
被 IDE 注入的 safe-delete shim 拦截（`rm -rf` 也会被拦截）。

**修复**：配置独立 `cacheDir: "node_modules/.vite-cache"`（新目录无需删除）。
必要时换一个新的 cacheDir 名字。

## 7. TypeScript strict 的 null 安全
`raycastBlock` 返回的 `prev` 可能为 `null`（命中点就是起点时）。
放置方块前必须 `if (!p) return;`，否则 strict 报 `TS18047`。

## 8. 无头截图验证法（很有用）
```bash
google-chrome --headless=new --no-sandbox --enable-unsafe-swiftshader \
  --hide-scrollbars --window-size=1280,720 --virtual-time-budget=15000 \
  --screenshot=/tmp/shot.png "http://localhost:5173/?debug=1&up&day"
```
然后用图像识别/肉眼查看截图。它能直接暴露"相机在方块内""缺面""全黑"等问题，
比读代码猜快得多。注意 SwiftShader 下 FPS 极低属正常现象。

## 9. 单元测试该测什么
- 数学/几何不变量（绕序、UV 范围、包围盒、面数量）
- 纯逻辑（噪声范围、红石传导、A* 可达性）
- 不要测渲染结果（用截图代替）
