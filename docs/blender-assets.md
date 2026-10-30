# Blender → Babylon.js 资产管线

本文总结 Minecraft 方块主角（`hero.glb`）从 Blender 建模到 Babylon.js 运行时接入的完整流程，可作为后续角色、道具、生物等 GLB 资产的开发规范。

## 1. 资产定位与目录

| 产物 | 路径 | 说明 |
|---|---|---|
| Blender 工程 | `d:/Codes/blender_minecraft/hero.blend` | 可继续编辑的源文件，含 `HERO` 与 `STUDIO` 两个集合 |
| 生成脚本 | `d:/Codes/blender_minecraft/create_hero.py` | 幂等重建模型、贴图、动画、预览与导出 |
| 像素图集 | `d:/Codes/blender_minecraft/hero_atlas.png` | 256×256，16×16 像素 tile |
| 预览图 | `d:/Codes/blender_minecraft/hero_preview.png` | Blender 渲染的最终造型检查图 |
| 运行时资产 | `public/assets/characters/hero.glb` | 内嵌贴图与动画，Vite 按根路径 `/assets/characters/hero.glb` 提供 |

约定：

- **源文件放在游戏仓库外**，只把导出的 GLB 作为游戏资产提交。
- 运行时资产统一放 `public/assets/<类别>/<名称>.glb`，路径与代码中的 URL 一致。
- 预览专用对象（相机、灯光、地面）放入 `STUDIO` 集合，导出时通过 selection 排除。

## 2. 一次性重建命令

```bash
"/d/Programs/blender-5.2.1-windows-x64/blender.exe" \
  --background --python-exit-code 1 \
  --python "d:/Codes/blender_minecraft/create_hero.py"
```

脚本内部顺序固定为：

1. 清空场景，生成像素图集并内嵌到材质；
2. 按方块部件建模、设置父子层级与关节 pivot；
3. 制作 `Idle` / `Walk` 两个 NLA 动画轨道；
4. 保存 `.blend` 并渲染预览图（**先预览，再导出**）；
5. 仅选中 `HERO` 集合导出 GLB 到 `public/assets/characters/`。

## 3. 建模约定（Blockbench 风格）

主角身高 `1.8` 米，与玩家碰撞盒（宽 `0.6`、高 `1.8`）一致：

| 部件 | 尺寸（m） | 关键点 |
|---|---|---|
| 头 | 0.45×0.45×0.45 | pivot 在颈部 `y=1.35` |
| 身体 | 0.45×0.225×0.675 | pivot 在胸口 `y≈1.01` |
| 手臂 | 0.1875×0.225×0.675 | pivot 在肩部，网格相对 pivot 下移半高 |
| 腿 | 0.2125×0.225×0.675 | pivot 在髋部 `y=0.675` |

必须遵守：

1. **原点在双脚中间的脚底**：`pos.y` 在游戏里表示脚底高度，模型不需要额外 offset。
2. **1 Blender 单位 = 1 游戏方块 = 1 米**：不要依赖导出时的缩放补偿。
3. **关节是空物体 pivot**：网格放在 pivot 下、并相对 pivot 偏移半高，旋转才发生在肩/髋而不是几何中心。
4. **视觉与碰撞解耦**：模型只负责外观；碰撞、寻路、网络同步继续使用原有 AABB 和 `pos/yaw`。
5. **正面朝向约定**：游戏水平前方是 `+Z`（`yaw=0` 朝 `+Z`）。Blender 的 `-Y` 正面经 glTF 导出后对应 Babylon 的 `+Z`，不需要额外旋转补偿。

## 4. 像素贴图与 UV

- 图集为 `256×256`，每 `16×16` 像素一个 tile，对应一个“面”的颜色设计。
- 每个方块部件有 6 个面 tile：`front, back, right, left, top, bottom`。
- 材质贴图节点设置 `Interpolation = Closest`，保证像素风不被模糊插值。
- UV 按“顶点在部件局部包围盒中的位置”映射到 tile 内部，每个面铺满整个 tile。
- 纹理通过 `image.pack()` 内嵌进 `.blend`，GLB 导出时也内嵌，运行时无需额外图片请求。

经验：先在 tile 上画“上半袖子 + 下半手掌”“裤腿 + 鞋底”这类纵向分区，可以只用 6 个面表达 Minecraft 经典造型，避免拆更多网格。

## 5. 动画

当前角色不使用骨骼蒙皮，而是对 **空物体 pivot 的旋转** 做关键帧：

- `Idle`：80 帧循环，手臂/头部微幅摆动；
- `Walk`：40 帧、24fps 循环，双腿 `±0.62rad`、双臂 `±0.58rad` 反相摆动；
- 每个部件的动作先做成 Action，再压入 NLA track，track 命名为 `Idle` / `Walk`；
- 打开 `.blend` 后按空格即可播放 Walk（脚本保存时会只启用 Walk 轨道便于预览）；
- 导出模式使用 `NLA_TRACKS`，GLB 中得到两个同名 `AnimationGroup`。

优点：方块人不需要蒙皮权重，导出/导入链路简单，动画组直接按名字播放。

## 6. GLB 导出参数

脚本中的关键导出设置：

```python
bpy.ops.export_scene.gltf(
    filepath=".../hero.glb",
    export_format="GLB",
    use_selection=True,            # 排除 STUDIO 预览集合
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_frame_range=False,
    export_force_sampling=True,    # 采样为运行时稳定的关键帧
    export_yup=True,               # glTF 标准 Y-up
)
```

导出后可快速校验 GLB 结构：

```bash
python - <<'PY'
import json, struct, pathlib
b = pathlib.Path("public/assets/characters/hero.glb").read_bytes()
n = struct.unpack_from("<I", b, 12)[0]
d = json.loads(b[20:20+n])
print("animations:", [a["name"] for a in d.get("animations", [])])
print("meshes:", len(d.get("meshes", [])), "images:", len(d.get("images", [])))
PY
```

当前 `hero.glb` 约 21KB：6 个网格、1 张内嵌贴图、2 组动画。

## 7. Babylon.js 运行时接入

依赖：`@babylonjs/loaders` 需与 `@babylonjs/core` 同主版本（当前 `^9.30.0`），并在入口模块引入 loader：

```ts
import "@babylonjs/loaders/glTF";
```

接入点在 `src/net.ts` 的远端玩家：

1. 先同步创建原有盒状角色作为 **fallback**；
2. 异步 `SceneLoader.ImportMeshAsync("", "/assets/characters/", "hero.glb", scene)`；
3. 加载成功后把 `result.meshes[0]` 挂到玩家根节点，删除 fallback；
4. 按名字取动画组：`Idle` / `Walk`；
5. 每帧根据 `pos` 与 `target` 的水平距离判断移动状态，切换动画；
6. 玩家离开或断线时，先 `dispose()` 动画组，再释放网格和根节点。

关键实现：

```ts
const moving = BABYLON.Vector3.DistanceSquared(r.pos, r.target) > 0.0025;
if (moving !== r.moving) {
  r.moving = moving;
  r.idle?.stop();
  r.walk?.stop();
  (moving ? r.walk : r.idle)?.start(true);
}
```

本地玩家目前是第一人称相机，没有可见角色网格；如需第三人称，可复用同一 GLB 加载逻辑并新增相机模式。

## 8. 验证清单

每次改模型或动画后：

1. Blender 内渲染预览图，确认比例、配色、面部朝向；
2. 打开 `.blend` 播放 Walk，确认关节 pivot 正确（不应出现“绕几何中心转”）；
3. 导出后用上面的脚本确认动画名、网格数、内嵌贴图；
4. `npx tsc --noEmit` + `npm test`；
5. `npm run build` 确认 GLB 被复制进 `dist/assets/characters/`；
6. 双开浏览器 + `npm run server` 联机观察远端玩家的模型、朝向与行走动画。

## 9. Babylon.js 资产开发经验总结

1. **先定约定，再建模**：原点、单位、正面方向、身高必须先与游戏坐标系对齐；事后补偿会污染所有动画。
2. **视觉和逻辑分离**：GLB 只替换“看得见的部分”，不要把碰撞盒、AI、网络状态绑进模型节点。
3. **像素风的关键是纹理采样**：Blender 中 `Closest` + 每面独立 tile，比拆碎几何更干净。
4. **刚体关节比蒙皮更适合方块人**：pivot 空物体 + 旋转关键帧即可得到 Minecraft 式行走，且 GLB 导入后就是普通 `AnimationGroup`。
5. **fallback 必须同步创建**：GLB 是异步加载，先用盒状角色占位，可以避免加载失败或慢网络时玩家“隐形”。
6. **异步资源要处理竞态与释放**：加载返回时玩家可能已离开；动画组是独立资源，`removeRemote` 时必须一并 `dispose()`，否则内存泄漏。
7. **Babylon 的 loader 是副作用注册**：只装 `@babylonjs/loaders` 不 `import "@babylonjs/loaders/glTF"` 会在运行时报找不到 `.glb` 插件。
8. **导出用 selection 控制内容**：预览相机/灯光/地面留在 `STUDIO` 集合，导出只选角色集合，避免垃圾节点进入游戏。
9. **资产小而内嵌**：21KB 内嵌贴图的 GLB 没有额外请求和材质依赖，非常适合局域网小游戏；后续大型资产可再考虑 KTX2/Draco。
10. **用可复现脚本管理源资产**：`create_hero.py` 能一键重建，比只保存 `.blend` 更利于回归、diff 和后续参数化换肤。
