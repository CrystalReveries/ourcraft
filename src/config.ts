/* 全局配置：世界尺寸、方块定义、工具/材料/食物、物理常量 */

export const SX = 192, SY = 64, SZ = 192;   // 世界尺寸（更开阔，约 2.3M 体素）
export const BUILD_LIMIT = 60;               // 建筑高度上限
export const SEA_LEVEL = 12;                 // 海平面（低于此高度的低洼处灌水）
export const REACH = 7;                      // 交互距离
export const ATTACK_REACH = 4;               // 攻击距离
export const GRAVITY = 26;
export const JUMP_V = 7.4;                   // 跳跃高度 ≈1.05 格（只能上 1 格台阶）

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, LOG: 5, LEAVES: 6,
  PLANKS: 7, COBBLE: 8, BRICKS: 9, GLASS: 10, GLOWSTONE: 11, BEDROCK: 12,
  SNOW: 13, BOOKSHELF: 14, DUST: 15, TORCH: 16, LEVER: 17, LAMP: 18,
  EMERALD_ORE: 19, DIAMOND_ORE: 20, COAL_ORE: 21, IRON_ORE: 22, GOLD_ORE: 23,
  GRAVEL: 24, CLAY: 25, SANDSTONE: 26, CACTUS: 27, MOSSY_COBBLE: 28,
  WATER: 29, TALL_GRASS: 30, FLOWER: 31,
} as const;

export type Special = "dust" | "torch" | "lever" | "lamp";
export type ToolType = "pick" | "axe" | "shovel" | "sword";

export interface BlockDef {
  id: number;
  name: string;
  color: string;
  top: number; side: number; bottom: number;
  solid: boolean;
  opaque: boolean;
  breakable: boolean;
  hardness: number;          // 空手基础秒数
  coin: number;
  tool?: ToolType;           // 高效工具类型
  drop?: string;             // 掉落物 id（默认方块自身）
  alpha?: number;
  special?: Special;
  cross?: boolean;           // 十字交叉植物（不渲染为立方体）
}

// 图集 tile（8列 x 4行）
export const T = {
  grassTop: 0, grassSide: 1, dirt: 2, stone: 3, sand: 4, logSide: 5, logTop: 6, leaves: 7,
  planks: 8, cobble: 9, bricks: 10, glass: 11, glow: 12, bedrock: 13, snow: 14, shelf: 15,
  dustOff: 16, dustOn: 17, lampOff: 18, lampOn: 19, emerald: 20, diamond: 21,
  coal: 22, iron: 23, gold: 24, gravel: 25, clay: 26, sandstone: 27, cactus: 28, mossy: 29,
  water: 30,
} as const;

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;

function def(id: number, name: string, color: string, tiles: [number, number, number],
             hardness: number, opts: Partial<BlockDef> = {}): BlockDef {
  return {
    id, name, color, top: tiles[0], side: tiles[1], bottom: tiles[2],
    solid: true, opaque: true, breakable: true, hardness, coin: 1, ...opts,
  };
}

export const DEFS: BlockDef[] = [];
DEFS[B.AIR] = def(B.AIR, "空气", "#000000", [0, 0, 0], 0, { solid: false, opaque: false, breakable: false });
DEFS[B.GRASS] = def(B.GRASS, "草方块", "#6f9b57", [T.grassTop, T.grassSide, T.dirt], 0.6, { tool: "shovel" });
DEFS[B.DIRT] = def(B.DIRT, "泥土", "#7a5a38", [T.dirt, T.dirt, T.dirt], 0.5, { tool: "shovel" });
DEFS[B.STONE] = def(B.STONE, "石头", "#8a8a8a", [T.stone, T.stone, T.stone], 2.0, { tool: "pick" });
DEFS[B.SAND] = def(B.SAND, "沙子", "#dbcf9a", [T.sand, T.sand, T.sand], 0.5, { tool: "shovel" });
DEFS[B.LOG] = def(B.LOG, "原木", "#6e5230", [T.logTop, T.logSide, T.logTop], 1.2, { tool: "axe" });
DEFS[B.LEAVES] = def(B.LEAVES, "树叶", "#3f6b33", [T.leaves, T.leaves, T.leaves], 0.2);
DEFS[B.PLANKS] = def(B.PLANKS, "木板", "#a3814f", [T.planks, T.planks, T.planks], 1.2, { tool: "axe" });
DEFS[B.COBBLE] = def(B.COBBLE, "圆石", "#6f6f6f", [T.cobble, T.cobble, T.cobble], 2.0, { tool: "pick" });
DEFS[B.BRICKS] = def(B.BRICKS, "砖块", "#9c5040", [T.bricks, T.bricks, T.bricks], 2.0, { tool: "pick" });
DEFS[B.GLASS] = def(B.GLASS, "玻璃", "#cfe8ef", [T.glass, T.glass, T.glass], 0.4, { opaque: false });
DEFS[B.GLOWSTONE] = def(B.GLOWSTONE, "萤石", "#e8c56a", [T.glow, T.glow, T.glow], 0.6, { tool: "pick" });
DEFS[B.BEDROCK] = def(B.BEDROCK, "基岩", "#333333", [T.bedrock, T.bedrock, T.bedrock], 999, { breakable: false });
DEFS[B.SNOW] = def(B.SNOW, "雪块", "#eef2f5", [T.snow, T.snow, T.snow], 0.5, { tool: "shovel" });
DEFS[B.BOOKSHELF] = def(B.BOOKSHELF, "书架", "#8a5a2a", [T.planks, T.shelf, T.planks], 1.2, { tool: "axe" });
DEFS[B.DUST] = def(B.DUST, "红石粉", "#aa0808", [-1, -1, -1], 0.1, { solid: false, opaque: false, special: "dust" });
DEFS[B.TORCH] = def(B.TORCH, "红石火把", "#ff9a3c", [-1, -1, -1], 0.1, { solid: false, opaque: false, special: "torch" });
DEFS[B.LEVER] = def(B.LEVER, "拉杆", "#8f8f8f", [-1, -1, -1], 0.1, { solid: false, opaque: false, special: "lever" });
DEFS[B.LAMP] = def(B.LAMP, "红石灯", "#c8a24a", [T.lampOff, T.lampOff, T.lampOff], 1.0, { special: "lamp" });
DEFS[B.EMERALD_ORE] = def(B.EMERALD_ORE, "绿宝石矿", "#18c46a", [T.emerald, T.emerald, T.emerald], 3.0, { coin: 25, tool: "pick" });
DEFS[B.DIAMOND_ORE] = def(B.DIAMOND_ORE, "钻石矿", "#4ee0e0", [T.diamond, T.diamond, T.diamond], 3.5, { coin: 40, tool: "pick", drop: "mat:diamond" });
DEFS[B.COAL_ORE] = def(B.COAL_ORE, "煤矿", "#3a3a3a", [T.coal, T.coal, T.coal], 2.5, { tool: "pick", drop: "mat:coal" });
DEFS[B.IRON_ORE] = def(B.IRON_ORE, "铁矿", "#c8a888", [T.iron, T.iron, T.iron], 3.0, { tool: "pick", drop: "mat:iron" });
DEFS[B.GOLD_ORE] = def(B.GOLD_ORE, "金矿", "#e8c84a", [T.gold, T.gold, T.gold], 3.0, { tool: "pick", drop: "mat:gold" });
DEFS[B.GRAVEL] = def(B.GRAVEL, "砂砾", "#8f8a84", [T.gravel, T.gravel, T.gravel], 0.8, { tool: "shovel" });
DEFS[B.CLAY] = def(B.CLAY, "黏土", "#a5b0c0", [T.clay, T.clay, T.clay], 0.8, { tool: "shovel" });
DEFS[B.SANDSTONE] = def(B.SANDSTONE, "砂岩", "#d8c48c", [T.sandstone, T.sandstone, T.sandstone], 1.6, { tool: "pick" });
DEFS[B.CACTUS] = def(B.CACTUS, "仙人掌", "#3f8a3f", [T.cactus, T.cactus, T.cactus], 0.8, { tool: "axe" });
DEFS[B.MOSSY_COBBLE] = def(B.MOSSY_COBBLE, "苔石", "#6b7f5f", [T.mossy, T.mossy, T.mossy], 2.0, { tool: "pick" });
// 水：可穿越、不可破坏；非不透明，让水下方块的顶面能被绘制，水体本身由独立半透明水面网格渲染
DEFS[B.WATER] = def(B.WATER, "水", "#3f6da8", [T.water, T.water, T.water], 0.5,
  { solid: false, breakable: false, opaque: false });
// 十字植物：不渲染成方块
DEFS[B.TALL_GRASS] = def(B.TALL_GRASS, "高草", "#6f9b57", [0, 0, 0], 0.05,
  { solid: false, opaque: false, cross: true, tool: "shovel" });
DEFS[B.FLOWER] = def(B.FLOWER, "野花", "#d86a8a", [0, 0, 0], 0.05,
  { solid: false, opaque: false, cross: true });

// ---------- 工具 ----------
export const TOOL_TIERS = ["wood", "stone", "iron", "gold", "diamond"] as const;
export type ToolTier = typeof TOOL_TIERS[number];
export const TIER_CN: Record<ToolTier, string> = {
  wood: "木", stone: "石", iron: "铁", gold: "金", diamond: "钻石",
};
export const TIER_SPEED: Record<ToolTier, number> = { wood: 2.2, stone: 3.5, iron: 5.5, gold: 7, diamond: 9 };
export const TIER_DAMAGE: Record<ToolTier, number> = { wood: 3, stone: 4, iron: 5, gold: 4, diamond: 6 };
export const TOOL_CN: Record<ToolType, string> = { pick: "镐", axe: "斧", shovel: "锹", sword: "剑" };
