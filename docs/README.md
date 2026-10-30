# Babylon MiniCraft 开发文档

长期目标：基于 Babylon.js 的 Minecraft 风格**局域网多人（<10 人）**体素沙盒游戏。
当前状态：**单人可玩版本（v1）已完成**，具备完整世界生成、建造/挖掘、红石、生物、昼夜天气、经济与管理系统。

## 文档索引
| 文档 | 内容 |
|---|---|
| [Features.md](./Features.md) | **功能清单与状态跟踪**（世界/玩家/工具/生物/联机/工程） |
| [architecture.md](./architecture.md) | 模块划分、数据流、关键数据结构、渲染与性能策略、扩展点 |
| [gameplay.md](./gameplay.md) | 操作、方块表、生物属性、工具/经济、世界生成、红石规则、命令 |
| [development.md](./development.md) | 环境搭建、命令、测试与截图验证流程、新增内容 checklist、Git 规范 |
| [blender-assets.md](./blender-assets.md) | Blender 建模/动画 → GLB 导出 → Babylon.js 加载的资产管线与经验 |
| [lessons.md](./lessons.md) | 已踩过的坑与经验（绕序/出生点/透明纹理/性能/WSL 工具链） |
| [roadmap.md](./roadmap.md) | 下一阶段：生物细节与贴图、多人模式、存档与扩展 |
| [multiplayer.md](./multiplayer.md) | 多人（LAN <10）技术方案：权威服务器、协议、同步与校验 |
| [network-troubleshooting.md](./network-troubleshooting.md) | 局域网其它设备连不上？防火墙/Hyper-V/WSL 端口排障 |

## 快速开始
```bash
npm install
npm run dev      # http://localhost:5173
npm run server   # LAN 服务器 ws://<房主IP>:8787（联机用）
npm test         # 几何单元测试
npx tsc --noEmit # 类型检查
```

## 关键约束（务必先读）
1. 方块几何绕序必须满足 `(p1-p0)×(p2-p0)·法线 < 0`（Babylon 前向面约定），`npm test` 守护
2. 图集纹理保持 `hasAlpha = false`；玻璃使用独立透明纹理
3. 玩家脚底 Y 必须落在地表方块**顶面之上**（`y + 1.0`）
4. 世界逻辑（world 数据/生成）未来需与渲染解耦，以便多人服务器复用
