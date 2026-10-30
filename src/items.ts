/* 物品系统：物品定义、背包、合成配方、工具查找 */
import {
  B, DEFS, TOOL_TIERS, TIER_CN, TIER_SPEED, TIER_DAMAGE, TOOL_CN,
  ToolType, ToolTier,
} from "./config";

export type ItemId = string;

export interface ItemDef {
  id: ItemId;
  name: string;
  color: string;
  kind: "block" | "tool" | "food" | "mat";
  blockId?: number;
  tool?: { type: ToolType; tier: ToolTier };
  food?: number;      // 恢复饥饿值
  max: number;
}

export const ITEMS: Record<ItemId, ItemDef> = {};

// 方块物品
for (const d of DEFS) {
  if (!d || d.id === B.AIR) continue;
  ITEMS[`b${d.id}`] = {
    id: `b${d.id}`, name: d.name, color: d.color, kind: "block", blockId: d.id, max: 999,
  };
}
// 材料
const MATS: Array<[string, string, string]> = [
  ["mat:stick", "木棍", "#a3814f"],
  ["mat:coal", "煤炭", "#2b2b2b"],
  ["mat:iron", "铁锭", "#d8d8d8"],
  ["mat:gold", "金锭", "#f0cf4a"],
  ["mat:diamond", "钻石", "#4ee0e0"],
];
for (const [id, name, color] of MATS) ITEMS[id] = { id, name, color, kind: "mat", max: 999 };
// 食物
const FOODS: Array<[string, string, string, number]> = [
  ["food:porkchop", "生猪排", "#e8a2a8", 4],
  ["food:mutton", "羊肉", "#d86060", 4],
  ["food:beef", "牛肉", "#a84040", 6],
  ["food:chicken", "鸡肉", "#f0d0a0", 2],
];
for (const [id, name, color, food] of FOODS) ITEMS[id] = { id, name, color, kind: "food", food, max: 64 };
// 工具
for (const tier of TOOL_TIERS) {
  for (const type of ["pick", "axe", "shovel", "sword"] as ToolType[]) {
    const id = `tool:${type}:${tier}`;
    ITEMS[id] = {
      id, name: `${TIER_CN[tier]}${TOOL_CN[type]}`, color: tierColor(tier),
      kind: "tool", tool: { type, tier }, max: 1,
    };
  }
}
function tierColor(tier: ToolTier): string {
  switch (tier) {
    case "wood": return "#a3814f";
    case "stone": return "#8a8a8a";
    case "iron": return "#d8d8d8";
    case "gold": return "#f0cf4a";
    case "diamond": return "#4ee0e0";
  }
}
export const blockItem = (id: number): ItemId => `b${id}`;
export const itemName = (id: ItemId): string => ITEMS[id]?.name ?? id;
export const itemColor = (id: ItemId): string => ITEMS[id]?.color ?? "#888";

// ---------- 背包 ----------
export interface Slot { id: ItemId; count: number; }

export class Inventory {
  slots: Array<Slot | null> = new Array(36).fill(null);
  selected = 0;

  add(id: ItemId, n: number): number {
    const max = ITEMS[id]?.max ?? 999;
    let left = n;
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      const s = this.slots[i];
      if (s && s.id === id && s.count < max) {
        const take = Math.min(max - s.count, left);
        s.count += take; left -= take;
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (!this.slots[i]) {
        const take = Math.min(max, left);
        this.slots[i] = { id, count: take };
        left -= take;
      }
    }
    return left;
  }
  count(id: ItemId): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }
  remove(id: ItemId, n: number): boolean {
    if (this.count(id) < n) return false;
    let left = n;
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, left);
      s.count -= take; left -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return true;
  }
  selectedSlot(): Slot | null { return this.slots[this.selected] ?? null; }
  clear(): void { this.slots.fill(null); }
}

// ---------- 合成 ----------
export interface Recipe {
  out: ItemId;
  count: number;
  need: Array<{ id: ItemId; count: number }>;
  hint: string;
}
const toolRecipe = (type: ToolType, tier: ToolTier, mat: ItemId): Recipe => {
  const matCount = type === "shovel" ? 1 : type === "sword" ? 2 : 3;
  const stickCount = type === "sword" ? 1 : 2;
  return {
    out: `tool:${type}:${tier}`, count: 1,
    need: [{ id: mat, count: matCount }, { id: "mat:stick", count: stickCount }],
    hint: `${matCount} 材料 + ${stickCount} 木棍`,
  };
};

export const RECIPES: Recipe[] = [
  { out: blockItem(B.PLANKS), count: 4, need: [{ id: blockItem(B.LOG), count: 1 }], hint: "1 原木" },
  { out: "mat:stick", count: 4, need: [{ id: blockItem(B.PLANKS), count: 2 }], hint: "2 木板" },
  { out: blockItem(B.TORCH), count: 4, need: [{ id: "mat:stick", count: 1 }, { id: "mat:coal", count: 1 }], hint: "1 木棍 + 1 煤炭" },
  { out: blockItem(B.COBBLE), count: 1, need: [{ id: blockItem(B.STONE), count: 1 }], hint: "1 石头" },
  { out: blockItem(B.SANDSTONE), count: 1, need: [{ id: blockItem(B.SAND), count: 2 }], hint: "2 沙子" },
  { out: blockItem(B.BRICKS), count: 1, need: [{ id: blockItem(B.CLAY), count: 2 }], hint: "2 黏土" },
  // 木
  toolRecipe("pick", "wood", blockItem(B.PLANKS)),
  toolRecipe("axe", "wood", blockItem(B.PLANKS)),
  toolRecipe("shovel", "wood", blockItem(B.PLANKS)),
  toolRecipe("sword", "wood", blockItem(B.PLANKS)),
  // 石
  toolRecipe("pick", "stone", blockItem(B.COBBLE)),
  toolRecipe("axe", "stone", blockItem(B.COBBLE)),
  toolRecipe("shovel", "stone", blockItem(B.COBBLE)),
  toolRecipe("sword", "stone", blockItem(B.COBBLE)),
  // 铁
  toolRecipe("pick", "iron", "mat:iron"),
  toolRecipe("axe", "iron", "mat:iron"),
  toolRecipe("shovel", "iron", "mat:iron"),
  toolRecipe("sword", "iron", "mat:iron"),
  // 金
  toolRecipe("pick", "gold", "mat:gold"),
  toolRecipe("axe", "gold", "mat:gold"),
  toolRecipe("shovel", "gold", "mat:gold"),
  toolRecipe("sword", "gold", "mat:gold"),
  // 钻石
  toolRecipe("pick", "diamond", "mat:diamond"),
  toolRecipe("axe", "diamond", "mat:diamond"),
  toolRecipe("shovel", "diamond", "mat:diamond"),
  toolRecipe("sword", "diamond", "mat:diamond"),
];

export function canCraft(inv: Inventory, r: Recipe): boolean {
  return r.need.every(n => inv.count(n.id) >= n.count);
}
export function craft(inv: Inventory, r: Recipe): boolean {
  if (!canCraft(inv, r)) return false;
  for (const n of r.need) inv.remove(n.id, n.count);
  inv.add(r.out, r.count);
  return true;
}

// ---------- 工具查询 ----------
export function bestTool(inv: Inventory, type: ToolType): { tier: ToolTier; speed: number } | null {
  let best: { tier: ToolTier; speed: number } | null = null;
  for (const s of inv.slots) {
    if (!s) continue;
    const d = ITEMS[s.id];
    if (!d || d.kind !== "tool" || !d.tool || d.tool.type !== type) continue;
    const speed = TIER_SPEED[d.tool.tier];
    if (!best || speed > best.speed) best = { tier: d.tool.tier, speed };
  }
  return best;
}
export function bestSwordDamage(inv: Inventory): number {
  let dmg = 1;
  for (const s of inv.slots) {
    if (!s) continue;
    const d = ITEMS[s.id];
    if (d?.tool?.type === "sword") dmg = Math.max(dmg, TIER_DAMAGE[d.tool.tier]);
  }
  return dmg;
}
export function toolLabel(inv: Inventory, type: ToolType): string {
  const b = bestTool(inv, type);
  return b ? `${TIER_CN[b.tier]}${TOOL_CN[type]}` : "空手";
}
