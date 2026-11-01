/* 世界模块：体素数据、地形/村庄生成、图集纹理、网格与实例管理、红石系统 */
import * as BABYLON from "@babylonjs/core";
import { SX, SY, SZ, BUILD_LIMIT, SEA_LEVEL, B, DEFS, BlockDef, T } from "./config";
import {
  buildBoxGeometry, buildPlantQuadGeometry, tileUV, faceDefs, appendBoxFace, GeoBuffers,
} from "./geometry";

let scene!: BABYLON.Scene;
export function initWorld(sc: BABYLON.Scene): void { scene = sc; }

// ---------- 体素数据 ----------
export const world = new Uint8Array(SX * SY * SZ);
const idx = (x: number, y: number, z: number): number => x + z * SX + y * SX * SZ;

export function getBlock(x: number, y: number, z: number): number {
  if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return B.AIR;
  return world[idx(x, y, z)];
}
function setBlockData(x: number, y: number, z: number, t: number): void {
  if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return;
  world[idx(x, y, z)] = t;
}
export const isSolid = (x: number, y: number, z: number): boolean => DEFS[getBlock(x, y, z)].solid;
const isTargetable = (x: number, y: number, z: number): boolean => {
  const id = getBlock(x, y, z);
  return id !== B.AIR && id !== B.WATER;   // 水不阻挡射线，可隔水交互
};

export function boxCollides(px: number, py: number, pz: number, hw: number, h: number): boolean {
  const x0 = Math.floor(px - hw), x1 = Math.floor(px + hw);
  const y0 = Math.floor(py + 0.001), y1 = Math.floor(py + h - 0.001);
  const z0 = Math.floor(pz - hw), z1 = Math.floor(pz + hw);
  for (let y = y0; y <= y1; y++)
    for (let z = z0; z <= z1; z++)
      for (let x = x0; x <= x1; x++)
        if (isSolid(x, y, z)) return true;
  return false;
}
export function surfaceY(x: number, z: number): number {
  let y = SY - 1;
  while (y > 0 && !isSolid(x, y - 1, z)) y--;
  return y;
}

// ---------- 噪声 ----------
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash2(x: number, z: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(z, 668265263) + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const smooth = (t: number): number => t * t * (3 - 2 * t);
function valueNoise(x: number, z: number, seed: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const a = hash2(xi, zi, seed), b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed), d = hash2(xi + 1, zi + 1, seed);
  const u = smooth(xf), v = smooth(zf);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}
// 更平滑的 fbm：scale 越大起伏越缓；oct=3 去掉高频"鼓包"
function fbmS(x: number, z: number, seed: number, scale: number, oct: number): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    sum += valueNoise((x * freq) / scale, (z * freq) / scale, seed + o * 131) * amp;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
// 山脊噪声：把 fbm 折叠成尖脊（自然山脉的主干），再平方让山脊更锐利、山谷更宽
function ridgedFbm(x: number, z: number, seed: number, scale: number, oct: number): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < oct; o++) {
    const n = 1 - Math.abs(valueNoise((x * freq) / scale, (z * freq) / scale, seed + o * 197) * 2 - 1);
    sum += n * n * amp;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}
const smoothstep01 = (t: number): number => {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
};

// ---------- 纹理图集（8列 x 3行, 64px/格） ----------
// tileUV 由 ./geometry 提供（纯函数，单元测试覆盖）
function makeAtlas(): BABYLON.DynamicTexture {
  const tile = 64;
  const tex = new BABYLON.DynamicTexture("atlas", { width: 512, height: 256 }, scene, true);
  tex.hasAlpha = false;   // 图集保持不透明: 开启 hasAlpha 会使所有方块进入透明管线, 产生深度排序漏洞
  // 单张图集 + 各向异性降为 1：iGPU 上 16x 各向异性采样的带宽成本换不来画质
  tex.anisotropicFilteringLevel = 1;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  const rng = mulberry32(12345);
  function noiseTile(t: number, base: string, speckle: string[], density: number): void {
    const r = tileUV(t);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    ctx.fillStyle = base;
    ctx.fillRect(x0, y0, tile, tile);
    for (let i = 0; i < density; i++) {
      ctx.fillStyle = speckle[(rng() * speckle.length) | 0];
      ctx.fillRect(x0 + rng() * tile, y0 + rng() * tile, 2 + rng() * 4, 2 + rng() * 4);
    }
  }
  // 更柔和的草色（去掉"荧光绿"）
  noiseTile(T.grassTop, "#6f9b57", ["#648c4c", "#7cab63", "#5c8347", "#86b06f"], 900);
  noiseTile(T.grassSide, "#6b4f2e", ["#5a4226", "#7d5d38"], 500);
  noiseTile(T.dirt, "#7a5a38", ["#6a4d2f", "#8a6a45"], 800);
  noiseTile(T.stone, "#8a8a8a", ["#7a7a7a", "#9a9a9a", "#6e6e6e"], 800);
  noiseTile(T.sand, "#dbcf9a", ["#cfc189", "#e8ddab"], 700);
  noiseTile(T.logSide, "#6e5230", ["#5d4426", "#7f6138"], 400);
  noiseTile(T.logTop, "#a3814f", ["#8f6f40", "#b5935e"], 500);
  noiseTile(T.leaves, "#3f6b33", ["#365e2b", "#4a7a3d", "#2f5426"], 900);
  noiseTile(T.planks, "#a3814f", ["#8f6f40", "#b5935e"], 500);
  noiseTile(T.cobble, "#6f6f6f", ["#5a5a5a", "#828282", "#4a4a4a"], 1000);
  noiseTile(T.bricks, "#9c5040", ["#8a4436", "#b06050"], 400);
  noiseTile(T.glow, "#e8c56a", ["#f5da8a", "#d4a94e", "#ffe9a8"], 700);
  noiseTile(T.bedrock, "#333333", ["#222222", "#444444", "#181818"], 1000);
  noiseTile(T.snow, "#eef2f5", ["#e0e6ec", "#f8fafc"], 500);
  noiseTile(T.emerald, "#7a7a7a", ["#6a6a6a", "#8a8a8a"], 600);
  noiseTile(T.diamond, "#7a7a7a", ["#6a6a6a", "#8a8a8a"], 600);
  noiseTile(T.lampOff, "#6a5326", ["#5a4620", "#7a6130"], 400);
  noiseTile(T.lampOn, "#e8c56a", ["#f5da8a", "#d4a94e"], 500);
  noiseTile(T.dustOff, "#5e0a0a", ["#4a0606", "#701010"], 600);
  noiseTile(T.dustOn, "#e01010", ["#c00c0c", "#ff3030"], 600);
  // 第3行: 煤矿/铁矿/金矿/砂砾/黏土/砂岩/仙人掌/苔石
  noiseTile(T.coal, "#7a7a7a", ["#6a6a6a", "#8a8a8a"], 600);
  noiseTile(T.iron, "#7a7a7a", ["#6a6a6a", "#8a8a8a"], 600);
  noiseTile(T.gold, "#7a7a7a", ["#6a6a6a", "#8a8a8a"], 600);
  noiseTile(T.gravel, "#8f8a84", ["#7a756f", "#a09a94", "#6a655f"], 1200);
  noiseTile(T.clay, "#a5b0c0", ["#95a0b0", "#b5c0d0"], 500);
  noiseTile(T.sandstone, "#d8c48c", ["#c8b47c", "#e8d49c"], 600);
  noiseTile(T.cactus, "#3f8a3f", ["#357a35", "#4a9a4a", "#2e6b2e"], 700);
  noiseTile(T.mossy, "#6b7f5f", ["#5a6f4f", "#7a8f6a", "#4a5f3f"], 1000);
  // 水面：偏灰蓝，带波纹噪点
  noiseTile(T.water, "#3f6da8", ["#35608f", "#4a7cb8", "#2f5a86", "#5688c4"], 900);

  // 草侧面顶部草皮
  {
    const r = tileUV(T.grassSide);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    ctx.fillStyle = "#6f9b57";
    ctx.fillRect(x0, y0, tile, 14);
    for (let i = 0; i < 70; i++) {
      ctx.fillStyle = rng() < 0.5 ? "#648c4c" : "#7cab63";
      ctx.fillRect(x0 + rng() * tile, y0 + 10 + rng() * 7, 3 + rng() * 3, 2 + rng() * 4);
    }
  }
  // 木头侧面竖纹
  {
    const r = tileUV(T.logSide);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    for (let x = 4; x < tile; x += 12) {
      ctx.fillStyle = "rgba(60,40,20,0.45)";
      ctx.fillRect(x0 + x, y0, 3, tile);
    }
  }
  // 砖缝
  {
    const r = tileUV(T.bricks);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    ctx.fillStyle = "#d8cfc4";
    for (let y = 0; y < tile; y += 16) ctx.fillRect(x0, y0 + y, tile, 3);
    for (let row = 0; row < 4; row++)
      for (let x = (row % 2) * 16; x < tile; x += 32)
        ctx.fillRect(x0 + x, y0 + row * 16, 3, 16);
  }
  // 玻璃：边框不透明，中间透明
  {
    const r = tileUV(T.glass);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    ctx.fillStyle = "rgba(210,235,240,0.9)";
    ctx.fillRect(x0, y0, tile, 5);
    ctx.fillRect(x0, y0 + tile - 5, tile, 5);
    ctx.fillRect(x0, y0, 5, tile);
    ctx.fillRect(x0 + tile - 5, y0, 5, tile);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillRect(x0 + 12, y0 + 10, 4, 26);
    ctx.fillRect(x0 + 40, y0 + 30, 4, 22);
  }
  // 书架侧面
  {
    const r = tileUV(T.shelf);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    ctx.fillStyle = "#a3814f";
    ctx.fillRect(x0, y0, tile, tile);
    const cols = ["#8a3030", "#30508a", "#3a8a4a", "#8a7a30", "#6a3a8a"];
    for (const yy of [8, 36]) {
      ctx.fillStyle = "#5d4426";
      ctx.fillRect(x0, y0 + yy, tile, 20);
      let bx = 2;
      while (bx < tile - 4) {
        const w = 5 + rng() * 7;
        ctx.fillStyle = cols[(rng() * cols.length) | 0];
        ctx.fillRect(x0 + bx, y0 + yy + 2, w, 18);
        bx += w + 2;
      }
    }
  }
  // 矿石斑点
  function oreSpots(t: number, color: string, glow: string): void {
    const r = tileUV(t);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    for (let i = 0; i < 7; i++) {
      const ox = x0 + 6 + rng() * 46, oy = y0 + 6 + rng() * 46;
      ctx.fillStyle = color;
      ctx.fillRect(ox, oy, 7, 7);
      ctx.fillStyle = glow;
      ctx.fillRect(ox + 1, oy + 1, 3, 3);
    }
  }
  oreSpots(T.emerald, "#18a85a", "#5aff9a");
  oreSpots(T.diamond, "#38b8c8", "#aef4ff");
  oreSpots(T.coal, "#2b2b2b", "#4a4a4a");
  oreSpots(T.iron, "#c8a888", "#e8d0b0");
  oreSpots(T.gold, "#e8c84a", "#ffe88a");
  tex.update();
  return tex;
}
// 玻璃使用独立透明纹理（图集本身不透明）
function makeGlassTexture(): BABYLON.DynamicTexture {
  const tex = new BABYLON.DynamicTexture("glassTex", { width: 64, height: 64 }, scene, true);
  tex.hasAlpha = true;
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, 64, 64);
  ctx.fillStyle = "rgba(215,238,244,0.30)";
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = "rgba(232,246,250,0.95)";
  ctx.fillRect(0, 0, 64, 5);
  ctx.fillRect(0, 59, 64, 5);
  ctx.fillRect(0, 0, 5, 64);
  ctx.fillRect(59, 0, 5, 64);
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.fillRect(12, 10, 4, 26);
  ctx.fillRect(40, 30, 4, 22);
  tex.update();
  return tex;
}

// ---------- 十字植物：4x4 植物图集（共享材质，减少材质/纹理切换） ----------
const PLANT_TILE = 64, PLANT_COLS = 4, PLANT_ROWS = 4;

type PlantDraw = (c: CanvasRenderingContext2D, rng: () => number) => void;
const hex = (arr: string[], rng: () => number): string => arr[(rng() * arr.length) | 0];

/** 一丛草叶：从贴图底部向上生长，带弯曲 */
function drawBlades(c: CanvasRenderingContext2D, rng: () => number, count: number,
                    colors: string[], minH: number, maxH: number, wMin: number, wMax: number): void {
  c.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const bx = 4 + rng() * 56;
    const hgt = minH + rng() * (maxH - minH);
    c.strokeStyle = hex(colors, rng);
    c.lineWidth = wMin + rng() * (wMax - wMin);
    c.beginPath();
    c.moveTo(bx, 64);
    c.quadraticCurveTo(bx + (rng() - 0.5) * 20, 64 - hgt * 0.62, bx + (rng() - 0.5) * 16, 64 - hgt);
    c.stroke();
  }
}
/** 花茎 + 两片叶子，返回花冠中心高度 */
function drawStem(c: CanvasRenderingContext2D, topY: number, color = "#4f7a3a"): void {
  c.strokeStyle = color;
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(32, 64);
  c.quadraticCurveTo(33, (64 + topY) / 2, 32, topY);
  c.stroke();
  c.fillStyle = "#5f8a49";
  c.beginPath(); c.ellipse(23, 50, 7, 3.2, -0.55, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(41, 55, 7, 3.2, 0.55, 0, Math.PI * 2); c.fill();
}
/** 放射状花瓣 + 花心 */
function drawDaisy(c: CanvasRenderingContext2D, cx: number, cy: number, petals: number,
                   petal: string, center: string, pr = 8, cw = 6, ch = 5): void {
  c.fillStyle = petal;
  for (let i = 0; i < petals; i++) {
    const a = (i / petals) * Math.PI * 2;
    c.beginPath();
    c.ellipse(cx + Math.cos(a) * pr, cy + Math.sin(a) * pr, cw, ch, a, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = center;
  c.beginPath(); c.arc(cx, cy, 4.5, 0, Math.PI * 2); c.fill();
}

// 4 种草：普通 / 矮密 / 带穗 / 宽叶
const GRASS_VARIANTS: PlantDraw[] = [
  (c, rng) => drawBlades(c, rng, 16, ["#6f9b57", "#5f8a49", "#7cab63", "#557d40"], 26, 58, 2, 4),
  (c, rng) => drawBlades(c, rng, 24, ["#5f8a49", "#547d3f", "#6f9b57"], 12, 30, 1.5, 3),
  (c, rng) => {
    drawBlades(c, rng, 11, ["#6f9b57", "#7cab63", "#557d40"], 36, 58, 1.5, 2.5);
    c.fillStyle = "#a8b86a";
    for (let i = 0; i < 9; i++) {
      const bx = 8 + rng() * 48, by = 8 + rng() * 26;
      c.beginPath(); c.ellipse(bx, by, 2.2, 4.6, (rng() - 0.5) * 0.8, 0, Math.PI * 2); c.fill();
    }
  },
  (c, rng) => drawBlades(c, rng, 9, ["#7cab63", "#8fbb6f", "#6f9b57"], 18, 44, 4.5, 7.5),
];

// 10 种花：粉雏菊 / 红虞美人 / 黄蒲公英 / 蓝矢车菊 / 紫郁金香 /
//           白雏菊 / 蓝铃花 / 紫绒球 / 橙百合 / 淡紫薰衣草
const FLOWER_VARIANTS: PlantDraw[] = [
  (c) => {
    drawStem(c, 30);
    drawDaisy(c, 32, 24, 6, "#e06a8a", "#f2d24a");
  },
  (c) => {
    drawStem(c, 30);
    c.fillStyle = "#d63a34";
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      c.beginPath();
      c.ellipse(32 + Math.cos(a) * 8, 24 + Math.sin(a) * 8, 9, 7, a, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#25160f";
    c.beginPath(); c.arc(32, 24, 4.5, 0, Math.PI * 2); c.fill();
  },
  (c) => {
    drawStem(c, 34);
    c.fillStyle = "#f2c433";
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      c.beginPath();
      c.ellipse(32 + Math.cos(a) * 7, 26 + Math.sin(a) * 7, 5, 2.6, a, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#ffe98a";
    c.beginPath(); c.arc(32, 26, 5, 0, Math.PI * 2); c.fill();
  },
  (c) => {
    drawStem(c, 32);
    c.fillStyle = "#5a7ad8";
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      c.beginPath();
      c.moveTo(32 + Math.cos(a) * 4, 24 + Math.sin(a) * 4);
      c.lineTo(32 + Math.cos(a + 0.16) * 12, 24 + Math.sin(a + 0.16) * 12);
      c.lineTo(32 + Math.cos(a - 0.16) * 12, 24 + Math.sin(a - 0.16) * 12);
      c.closePath(); c.fill();
    }
    c.fillStyle = "#dbe4ff";
    c.beginPath(); c.arc(32, 24, 3.6, 0, Math.PI * 2); c.fill();
  },
  (c) => {
    drawStem(c, 36);
    c.fillStyle = "#9b4bd6";
    c.beginPath();
    c.moveTo(32, 8);
    c.quadraticCurveTo(44, 20, 38, 32);
    c.quadraticCurveTo(32, 26, 26, 32);
    c.quadraticCurveTo(20, 20, 32, 8);
    c.fill();
    c.fillStyle = "#b96be8";
    c.beginPath(); c.ellipse(32, 20, 4, 10, 0, 0, Math.PI * 2); c.fill();
  },
  (c) => {
    drawStem(c, 30);
    drawDaisy(c, 32, 24, 8, "#f4f7f2", "#f2c433", 9, 6.5, 4.2);
  },
  (c) => {
    drawStem(c, 20);
    c.strokeStyle = "#4f7a3a"; c.lineWidth = 2.4;
    c.beginPath(); c.moveTo(32, 26); c.lineTo(32, 20); c.stroke();
    c.fillStyle = "#6b8ae0";
    for (let i = 0; i < 3; i++) {
      const bx = 22 + i * 10, by = 14 + (i % 2) * 6;
      c.beginPath(); c.ellipse(bx, by, 5.5, 6.5, 0, Math.PI, Math.PI * 2); c.fill();
      c.fillStyle = "#8fa8ee";
      c.beginPath(); c.ellipse(bx, by + 2, 2, 2.4, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#6b8ae0";
    }
  },
  (c) => {
    drawStem(c, 22);
    c.fillStyle = "#9a6ad8";
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2, r = 2 + (i % 3) * 2.4;
      c.beginPath();
      c.arc(32 + Math.cos(a) * r * 1.6, 20 + Math.sin(a) * r * 1.6, 3.2, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#c39bf0";
    c.beginPath(); c.arc(32, 20, 3, 0, Math.PI * 2); c.fill();
  },
  (c) => {
    drawStem(c, 34);
    c.fillStyle = "#e8823a";
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + (i - 2) * 0.62;
      c.beginPath();
      c.ellipse(32 + Math.cos(a) * 8, 26 + Math.sin(a) * 8, 4.4, 9, a + Math.PI / 2, 0, Math.PI * 2);
      c.fill();
    }
    c.fillStyle = "#a83a1a";
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      c.beginPath(); c.arc(32 + Math.cos(a) * 5, 26 + Math.sin(a) * 5, 1.4, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = "#f2c433";
    c.beginPath(); c.arc(32, 26, 3, 0, Math.PI * 2); c.fill();
  },
  (c) => {
    c.strokeStyle = "#4f7a3a"; c.lineWidth = 3;
    for (let k = 0; k < 3; k++) {
      const bx = 20 + k * 12;
      c.beginPath(); c.moveTo(bx, 64); c.quadraticCurveTo(bx + 2, 40, bx, 12 + k * 4); c.stroke();
      c.fillStyle = "#a97fe0";
      for (let i = 0; i < 6; i++) {
        c.beginPath();
        c.ellipse(bx + (i % 2 ? 3 : -3), 14 + k * 4 + i * 3.4, 3, 4.2, 0, 0, Math.PI * 2);
        c.fill();
      }
    }
  },
];

/** 植物图集：4x4，每格 64px，带 alpha */
function makePlantAtlas(): BABYLON.DynamicTexture {
  const size = PLANT_TILE * PLANT_COLS;
  const tex = new BABYLON.DynamicTexture("plantAtlas", { width: size, height: size }, scene, true);
  const ctx = tex.getContext() as CanvasRenderingContext2D;
  ctx.clearRect(0, 0, size, size);
  const rng = mulberry32(90210);
  const all = [...GRASS_VARIANTS, ...FLOWER_VARIANTS];
  for (let i = 0; i < all.length; i++) {
    const tx = (i % PLANT_COLS) * PLANT_TILE;
    const ty = Math.floor(i / PLANT_COLS) * PLANT_TILE;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.beginPath(); ctx.rect(0, 0, PLANT_TILE, PLANT_TILE); ctx.clip();
    all[i](ctx, rng);
    ctx.restore();
  }
  tex.update();
  tex.hasAlpha = true;
  tex.anisotropicFilteringLevel = 1;
  return tex;
}

const PLANT_GRASS_TILES = GRASS_VARIANTS.map((_, i) => i);
const PLANT_FLOWER_TILE0 = GRASS_VARIANTS.length;
let plantMat!: BABYLON.StandardMaterial;
const plantQuadCache = new Map<number, ReturnType<typeof buildPlantQuadGeometry>>();

/** 植物材质（十字交叉半透明，所有区块网格共享） */
function initPlantMaterial(): void {
  const mat = new BABYLON.StandardMaterial("matPlant", scene);
  mat.diffuseTexture = makePlantAtlas();
  mat.useAlphaFromDiffuseTexture = true;
  mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  mat.backFaceCulling = false;
  mat.diffuseColor = new BABYLON.Color3(1, 1, 1);
  mat.specularColor = BABYLON.Color3.Black();
  mat.emissiveColor = new BABYLON.Color3(0.1, 0.12, 0.07);
  plantMat = mat;
}

/** 按坐标确定性选取植物 tile（同一位置始终同一外观，且不需要额外方块 id） */
function plantTileFor(id: number, x: number, y: number, z: number): number {
  let h = Math.imul(x, 73856093) ^ Math.imul(z, 19349663) ^ Math.imul(y, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  const count = id === B.FLOWER ? FLOWER_VARIANTS.length : PLANT_GRASS_TILES.length;
  const idx = ((h ^ (h >>> 16)) >>> 0) % count;
  return id === B.FLOWER ? PLANT_FLOWER_TILE0 + idx : idx;
}

/** 把十字植物（两片交叉四边形）追加进区块缓冲 */
function appendPlant(buf: GeoBuffers, id: number, x: number, y: number, z: number): void {
  const tile = plantTileFor(id, x, y, z);
  let g = plantQuadCache.get(tile);
  if (!g) {
    g = buildPlantQuadGeometry(tile, PLANT_COLS, PLANT_ROWS);
    plantQuadCache.set(tile, g);
  }
  for (let pass = 0; pass < 2; pass++) {
    const base = buf.positions.length / 3;
    const rotate = pass === 1;    // 第二片绕 Y 轴旋转 90°，形成十字交叉
    for (let i = 0; i < g.positions.length; i += 3) {
      const px = g.positions[i], py = g.positions[i + 1], pz = g.positions[i + 2];
      if (rotate) buf.positions.push(-pz + x + 0.5, py + y, px + z + 0.5);
      else buf.positions.push(px + x + 0.5, py + y, pz + z + 0.5);
      buf.normals.push(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
    }
    for (const uv of g.uvs) buf.uvs.push(uv);
    for (const i of g.indices) buf.indices.push(base + i);
  }
}

// ---------- 水面：单网格 + 自定义 shader（透明、波动、菲涅尔） ----------
/** 水面渲染档位：shader=波动着色器，flat=纯色平面（无波动/无逐像素光照），off=不绘制 */
export type WaterMode = "shader" | "flat" | "off";
let waterMode: WaterMode = "shader";
let waterMesh: BABYLON.Mesh | null = null;
let waterMat: BABYLON.ShaderMaterial | null = null;
let waterFlatMat: BABYLON.StandardMaterial | null = null;
let waterTimeObs: BABYLON.Observer<BABYLON.Scene> | null = null;

const WATER_VERTEX = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 worldViewProjection;
uniform float time;
varying vec3 vWorldPos;
varying float vWave;
void main(void) {
  vec3 p = position;
  float w = sin(p.x * 0.55 + time * 1.6) * 0.055
          + sin(p.z * 0.72 - time * 1.25) * 0.050
          + sin((p.x + p.z) * 1.15 + time * 2.2) * 0.022;
  p.y += w;
  vWave = w;
  vWorldPos = (world * vec4(p, 1.0)).xyz;
  gl_Position = worldViewProjection * vec4(p, 1.0);
}
`;
const WATER_FRAGMENT = `
precision highp float;
varying vec3 vWorldPos;
varying float vWave;
uniform vec3 cameraPosition;
uniform vec3 deepColor;
uniform vec3 shallowColor;
uniform vec3 fogColor;
uniform float time;
void main(void) {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fres = pow(1.0 - clamp(abs(viewDir.y), 0.0, 1.0), 3.0);
  vec3 n = normalize(vec3(
    sin(vWorldPos.x * 0.9 + time * 1.7) * 0.20,
    1.0,
    sin(vWorldPos.z * 0.8 - time * 1.4) * 0.20));
  float spec = pow(max(dot(reflect(-normalize(vec3(-0.4, -1.0, 0.3)), n), viewDir), 0.0), 48.0);
  vec3 col = mix(deepColor, shallowColor, clamp(fres + 0.30 + vWave * 1.6, 0.0, 1.0));
  col += vec3(0.95, 0.98, 1.0) * spec * 0.32;
  float ripple = sin(vWorldPos.x * 3.1 + time * 2.3) * sin(vWorldPos.z * 3.4 - time * 1.9);
  col += vec3(0.06, 0.10, 0.12) * smoothstep(0.92, 1.0, ripple);
  // 远程水面同样受雾影响，否则会和雾中的地形脱节
  float fogD = length(cameraPosition - vWorldPos);
  gl_FragColor = vec4(mix(col, fogColor, smoothstep(70.0, 190.0, fogD)), 0.42 + fres * 0.34);
}
`;

/** 应用当前水面档位（切换材质 / 可见性，避免 off 档仍产生 draw call） */
function applyWaterMode(): void {
  if (!waterMesh) return;
  waterMesh.isVisible = waterMode !== "off";
  if (waterMode === "flat") {
    if (!waterFlatMat) {
      const m = new BABYLON.StandardMaterial("matWaterFlat", scene);
      m.disableLighting = true;                       // 顶点无 normals/uv，关闭光照避免算出全黑
      m.emissiveColor = BABYLON.Color3.FromHexString("#2f6f9e");
      m.specularColor = BABYLON.Color3.Black();
      m.alpha = 0.55;
      m.backFaceCulling = false;
      waterFlatMat = m;
    }
    waterMesh.material = waterFlatMat;
  } else if (waterMat) {
    waterMesh.material = waterMat;
  }
}

/** 切换水面渲染档位：用于性能排查与低端机降级 */
export function setWaterMode(mode: WaterMode): void {
  waterMode = mode;
  applyWaterMode();
}
export function getWaterMode(): WaterMode { return waterMode; }

/** 扫描所有水体，只暴露"上方不是水且不是实心方块"的顶面，合成一张静态水面网格 */
function buildWaterSurface(): void {
  if (waterMesh) { waterMesh.dispose(); waterMesh = null; }
  if (waterTimeObs) { scene.onBeforeRenderObservable.remove(waterTimeObs); waterTimeObs = null; }

  const positions: number[] = [], indices: number[] = [];
  const eps = 0.015;
  for (let y = 0; y < SY; y++)
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        if (getBlock(x, y, z) !== B.WATER) continue;
        const above = getBlock(x, y + 1, z);
        if (above === B.WATER || DEFS[above].opaque) continue;
        const wy = y + 1 - eps;
        const base = positions.length / 3;
        positions.push(x, wy, z + 1, x + 1, wy, z + 1, x + 1, wy, z, x, wy, z);
        indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
      }
  if (positions.length === 0) return;

  const mesh = new BABYLON.Mesh("waterSurface", scene);
  const vd = new BABYLON.VertexData();
  vd.positions = positions;
  vd.indices = indices;
  vd.applyToMesh(mesh, false);
  mesh.isPickable = false;

  BABYLON.Effect.ShadersStore["mcWaterVertexShader"] = WATER_VERTEX;
  BABYLON.Effect.ShadersStore["mcWaterFragmentShader"] = WATER_FRAGMENT;
  const mat = new BABYLON.ShaderMaterial("matWater", scene,
    { vertex: "mcWater", fragment: "mcWater" },
    {
      attributes: ["position"],
      uniforms: ["world", "worldViewProjection", "cameraPosition", "time", "deepColor", "shallowColor", "fogColor"],
      needAlphaBlending: true,
    });
  mat.backFaceCulling = false;
  mat.setColor3("deepColor", BABYLON.Color3.FromHexString("#123d5c"));
  mat.setColor3("shallowColor", BABYLON.Color3.FromHexString("#4a9bbd"));
  mesh.material = mat;
  mesh.freezeWorldMatrix();

  waterMesh = mesh;
  waterMat = mat;
  waterTimeObs = scene.onBeforeRenderObservable.add(() => {
    if (waterMode !== "shader") return;   // flat/off 档不需要每帧推 uniform
    waterMat?.setFloat("time", performance.now() * 0.001);
    waterMat?.setColor3("fogColor", scene.fogColor);
  });
  applyWaterMode();
}

// ---------- 网格构建 ----------
let atlas!: BABYLON.DynamicTexture;
let glassTex!: BABYLON.DynamicTexture;
function boxGeo(tiles: { top: number; side: number; bottom: number }): BABYLON.VertexData {
  const g = buildBoxGeometry(tiles);   // 绕序已在 geometry 模块中修正并有 UT 覆盖
  const vd = new BABYLON.VertexData();
  vd.positions = g.positions;
  vd.normals = g.normals;
  vd.uvs = g.uvs;
  vd.indices = g.indices;
  return vd;
}
function coloredMat(name: string, hex: string, emissive = 0): BABYLON.StandardMaterial {
  const m = new BABYLON.StandardMaterial(name, scene);
  m.diffuseColor = BABYLON.Color3.FromHexString(hex);
  m.specularColor = BABYLON.Color3.Black();
  if (emissive > 0) m.emissiveColor = BABYLON.Color3.FromHexString(hex).scale(emissive);
  return m;
}
function buildBlockMesh(id: number): BABYLON.Mesh {
  const d = DEFS[id];
  const mesh = new BABYLON.Mesh("block_" + id, scene);
  boxGeo({ top: d.top, side: d.side, bottom: d.bottom }).applyToMesh(mesh);
  const mat = new BABYLON.StandardMaterial("mat_" + id, scene);
  mat.diffuseTexture = atlas;
  mat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
  if (id === B.GLASS) { mat.diffuseTexture = glassTex; mat.backFaceCulling = false; }
  if (id === B.GLOWSTONE) mat.emissiveColor = new BABYLON.Color3(0.55, 0.45, 0.2);
  mesh.material = mat;
  mesh.isVisible = false;
  mesh.freezeWorldMatrix();
  return mesh;
}
function buildBoxMesh(name: string, w: number, h: number, dpt: number, y: number,
                      mat: BABYLON.Material): BABYLON.Mesh {
  const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: dpt }, scene);
  m.position.y = y;
  m.material = mat;
  m.isVisible = false;
  m.freezeWorldMatrix();
  return m;
}

// ---------- 主网格与实例 ----------
// 渲染策略（性能核心，见 docs/PERFORMANCE.md）：
//   · 普通立方体 + 玻璃 → 合并进「区块网格」，每 16×16×SY 一张静态网格，1 个 draw call
//   · 特殊几何（红石粉/火把/拉杆/红石灯）、十字植物、萤石 → 保留实例（数量少，各有材质）
// 旧方案是每个可见方块一个 InstancedMesh（约 10 万个 Mesh 对象），
// Babylon 每帧评估 active mesh 要遍历全部 mesh，实测 78ms/帧。
const CHUNK = 16;
const CHUNKS_X = SX / CHUNK, CHUNKS_Z = SZ / CHUNK;
interface ChunkMeshes {
  opaque: BABYLON.Mesh | null;
  glass: BABYLON.Mesh | null;
  plant: BABYLON.Mesh | null;
}
const chunkMeshes = new Map<number, ChunkMeshes>();
let terrainMat!: BABYLON.StandardMaterial;      // 图集材质（所有区块共享）
let glassChunkMat!: BABYLON.StandardMaterial;

const masters = new Map<number, BABYLON.Mesh>();   // 仅实例方块使用
let dustOffM!: BABYLON.Mesh, dustOnM!: BABYLON.Mesh;
let lampOffM!: BABYLON.Mesh, lampOnM!: BABYLON.Mesh;
let leverOffM!: BABYLON.Mesh, leverOnM!: BABYLON.Mesh;
let torchM!: BABYLON.Mesh;
const instances = new Map<string, BABYLON.InstancedMesh>();
const keyOf = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const dustOn = new Set<string>();
const lampLit = new Set<string>();
export const leverOn = new Set<string>();

// 热循环查表：区块重建要跑 16×16×SY 个方块 × 6 面，
// 每次访问 DEFS[id].opaque / .special 这种对象属性是实测热点，
// 预先摊平成 Uint8Array，内层循环只剩数组索引。
const OPAQUE_T = new Uint8Array(256);
const CHUNK_BLOCK_T = new Uint8Array(256);
const CROSS_T = new Uint8Array(256);
const GLASS_T = new Uint8Array(256);
for (let id = 0; id < 256; id++) {
  const d = DEFS[id];
  if (!d) continue;
  OPAQUE_T[id] = d.opaque ? 1 : 0;
  CROSS_T[id] = d.cross ? 1 : 0;
  GLASS_T[id] = id === B.GLASS ? 1 : 0;
  CHUNK_BLOCK_T[id] = (id !== B.AIR && id !== B.WATER && !d.special && id !== B.GLOWSTONE) ? 1 : 0;
}
/** 六面邻居的体素索引偏移（与 faceDefs 顺序一致：+Y -Y +Z -Z +X -X） */
const FACE_OFF = [SX * SZ, -SX * SZ, SX, -SX, 1, -1];
const FACE_NX = [0, 0, 0, 0, 1, -1];
const FACE_NY = [1, -1, 0, 0, 0, 0];
const FACE_NZ = [0, 0, 1, -1, 0, 0];

/** 需要独立实例的方块（红石元件/萤石；其余全部走区块网格，见 CHUNK_BLOCK_T） */
function isInstanceBlock(id: number): boolean {
  return CHUNK_BLOCK_T[id] === 0 && id !== B.AIR && id !== B.WATER;
}
/** 邻居是否"遮挡"：世界底面外=不透明（基岩脚下永远看不见），天空=透明，水平边界外=不透明 */
function opaqueAt(x: number, y: number, z: number): boolean {
  if (y < 0) return true;
  if (y >= SY) return false;
  if (x < 0 || z < 0 || x >= SX || z >= SZ) return true;
  return OPAQUE_T[world[idx(x, y, z)]] === 1;
}

const faceDefsCache = new Map<number, ReturnType<typeof faceDefs>>();
function facesOf(id: number): ReturnType<typeof faceDefs> {
  let f = faceDefsCache.get(id);
  if (!f) {
    const d = DEFS[id];
    f = faceDefs({ top: d.top, side: d.side, bottom: d.bottom });
    faceDefsCache.set(id, f);
  }
  return f;
}

function attachChunkMesh(name: string, buf: GeoBuffers, mat: BABYLON.Material,
                         prev: BABYLON.Mesh | null): BABYLON.Mesh | null {
  if (buf.indices.length === 0) {
    if (prev) prev.setEnabled(false);      // 区块变空：保留对象，隐藏即可（避免频繁创建/销毁）
    return prev;
  }
  const mesh = prev ?? new BABYLON.Mesh(name, scene);
  if (!prev) {
    mesh.material = mat;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.freezeWorldMatrix();              // 位置恒为原点，世界矩阵冻结
  } else {
    mesh.setEnabled(true);
  }
  const vd = new BABYLON.VertexData();
  vd.positions = buf.positions;
  vd.normals = buf.normals;
  vd.uvs = buf.uvs;
  vd.indices = buf.indices;
  vd.applyToMesh(mesh, false);
  mesh.refreshBoundingInfo();              // 几何变化后重算包围盒，视锥剔除才正确
  return mesh;
}

/** 重建一个区块的合并网格（仅遍历本区块 16×16×SY 个方块） */
function buildChunk(cx: number, cz: number): void {
  const key = cx + cz * CHUNKS_X;
  const prev = chunkMeshes.get(key) ?? { opaque: null, glass: null, plant: null };
  const opaqueBuf: GeoBuffers = { positions: [], normals: [], uvs: [], indices: [] };
  const glassBuf: GeoBuffers = { positions: [], normals: [], uvs: [], indices: [] };
  const plantBuf: GeoBuffers = { positions: [], normals: [], uvs: [], indices: [] };
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  // 直接索引遍历（不调用 getBlock/opaqueAt），内层只做数组读 + 查表
  const YS = SX * SZ;
  for (let y = 0; y < SY; y++)
    for (let z = z0; z < z0 + CHUNK; z++)
      for (let x = x0; x < x0 + CHUNK; x++) {
        const i = x + z * SX + y * YS;
        const id = world[i];
        if (CHUNK_BLOCK_T[id] === 0) continue;
        if (CROSS_T[id] === 1) { appendPlant(plantBuf, id, x, y, z); continue; }
        const buf = GLASS_T[id] === 1 ? glassBuf : opaqueBuf;
        const faces = facesOf(id);
        for (let k = 0; k < 6; k++) {
          const ny = y + FACE_NY[k];
          if (ny < 0) continue;                       // 世界底面外：永远看不到
          if (ny < SY) {
            const nx = x + FACE_NX[k], nz = z + FACE_NZ[k];
            if (nx < 0 || nz < 0 || nx >= SX || nz >= SZ) continue;   // 水平边界外视为不透明
            if (OPAQUE_T[world[i + FACE_OFF[k]]] === 1) continue;      // 被邻居挡住
          }                                            // ny >= SY：天空，必画
          appendBoxFace(buf, faces[k], x, y, z);
        }
      }
  const entry: ChunkMeshes = {
    opaque: attachChunkMesh(`chunk_${cx}_${cz}`, opaqueBuf, terrainMat, prev.opaque),
    glass: attachChunkMesh(`chunkg_${cx}_${cz}`, glassBuf, glassChunkMat, prev.glass),
    plant: attachChunkMesh(`chunkp_${cx}_${cz}`, plantBuf, plantMat, prev.plant),
  };
  chunkMeshes.set(key, entry);
}

/** 方块变化后重建受影响区块：本区块 + 边界上的相邻区块 */
function rebuildChunksAt(x: number, z: number): void {
  const cx = x >> 4, cz = z >> 4;
  buildChunk(cx, cz);
  if ((x & 15) === 0 && cx > 0) buildChunk(cx - 1, cz);
  if ((x & 15) === 15 && cx < CHUNKS_X - 1) buildChunk(cx + 1, cz);
  if ((z & 15) === 0 && cz > 0) buildChunk(cx, cz - 1);
  if ((z & 15) === 15 && cz < CHUNKS_Z - 1) buildChunk(cx, cz + 1);
}

function buildSpecialMasters(): void {
  dustOffM = buildBoxMesh("dustOff", 1, 0.1, 1, 0.05, coloredMat("dustOffM", "#5e0a0a"));
  dustOnM = buildBoxMesh("dustOn", 1, 0.1, 1, 0.05, coloredMat("dustOnM", "#e01010", 0.6));
  torchM = buildBoxMesh("torch", 0.14, 0.7, 0.14, 0.35, coloredMat("torchM", "#c96a2a", 0.45));
  const base = buildBoxMesh("lvBase", 0.9, 0.12, 0.9, 0.06, coloredMat("lvBaseM", "#7a7a7a"));
  const hOff = buildBoxMesh("lvHOff", 0.14, 0.45, 0.14, 0.32, coloredMat("lvHOffM", "#5a5a5a"));
  const hOn = buildBoxMesh("lvHOn", 0.14, 0.45, 0.14, 0.32, coloredMat("lvHOnM", "#30c060", 0.5));
  leverOffM = BABYLON.Mesh.MergeMeshes([base, hOff], true, true)!;
  leverOffM.isVisible = false;
  const base2 = buildBoxMesh("lvBase2", 0.9, 0.12, 0.9, 0.06, coloredMat("lvBaseM2", "#7a7a7a"));
  leverOnM = BABYLON.Mesh.MergeMeshes([base2, hOn], true, true)!;
  leverOnM.isVisible = false;
  leverOffM.freezeWorldMatrix();
  leverOnM.freezeWorldMatrix();
  lampOffM = buildBoxMesh("lampOff", 1, 1, 1, 0.5, coloredMat("lampOffM", "#6a5326"));
  lampOnM = buildBoxMesh("lampOn", 1, 1, 1, 0.5, coloredMat("lampOnM", "#e8c56a", 0.85));
}

function masterFor(x: number, y: number, z: number, id: number): { mesh: BABYLON.Mesh; yOff: number } {
  const k = keyOf(x, y, z);
  const sp = DEFS[id].special;
  if (sp === "dust") return { mesh: dustOn.has(k) ? dustOnM : dustOffM, yOff: 0 };
  if (sp === "torch") return { mesh: torchM, yOff: 0 };
  if (sp === "lever") return { mesh: leverOn.has(k) ? leverOnM : leverOffM, yOff: 0 };
  if (sp === "lamp") return { mesh: lampLit.has(k) ? lampOnM : lampOffM, yOff: 0.5 };
  return { mesh: masters.get(id)!, yOff: 0.5 };
}
function spawnInstance(key: string, x: number, y: number, z: number): void {
  const id = getBlock(x, y, z);
  if (!isInstanceBlock(id)) return;
  const { mesh, yOff } = masterFor(x, y, z, id);
  const inst = mesh.createInstance(key);
  inst.position.set(x + 0.5, y + yOff, z + 0.5);
  inst.freezeWorldMatrix();   // 静态方块: 冻结世界矩阵避免每帧重算
  instances.set(key, inst);
}
function removeInstance(key: string): void {
  const inst = instances.get(key);
  if (inst) { inst.dispose(); instances.delete(key); }
}
/** 实例方块是否需要存在：特殊几何/植物总是需要；萤石只在有暴露面时建 */
function faceVisible(x: number, y: number, z: number): boolean {
  const id = getBlock(x, y, z);
  if (!isInstanceBlock(id)) return false;   // 普通方块/植物由区块网格渲染，不再建实例
  const d = DEFS[id];
  if (d.special) return true;
  return !opaqueAt(x + 1, y, z) || !opaqueAt(x - 1, y, z) ||
         !opaqueAt(x, y + 1, z) || !opaqueAt(x, y - 1, z) ||
         !opaqueAt(x, y, z + 1) || !opaqueAt(x, y, z - 1);
}
export function updateInstancesAt(x: number, y: number, z: number): void {
  rebuildChunksAt(x, z);
  const cells: Array<[number, number, number]> = [
    [x, y, z], [x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1],
  ];
  for (const [cx, cy, cz] of cells) {
    const k = keyOf(cx, cy, cz);
    const want = faceVisible(cx, cy, cz);
    if (want && !instances.has(k)) spawnInstance(k, cx, cy, cz);
    else if (!want && instances.has(k)) removeInstance(k);
  }
}
export function buildAllInstances(): void {
  for (let cz = 0; cz < CHUNKS_Z; cz++)
    for (let cx = 0; cx < CHUNKS_X; cx++)
      buildChunk(cx, cz);
  for (let y = 0; y < SY; y++)
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++)
        if (faceVisible(x, y, z)) spawnInstance(keyOf(x, y, z), x, y, z);
}

// ---------- 红石系统 ----------
// ---------- 红石元件注册表（增量维护，避免全图扫描） ----------
const redstoneCells = new Map<string, "dust" | "torch" | "lever" | "lamp">();
function updateRedstoneRegistry(x: number, y: number, z: number): void {
  const k = keyOf(x, y, z);
  const sp = DEFS[getBlock(x, y, z)].special;
  if (sp) redstoneCells.set(k, sp);
  else redstoneCells.delete(k);
}
function redstoneNearby(x: number, y: number, z: number): boolean {
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        if (redstoneCells.has(keyOf(x + dx, y + dy, z + dz))) return true;
  return false;
}

export function recomputeRedstone(): void {
  const sources: Array<{ x: number; y: number; z: number; k: string }> = [];
  const dustCells: Array<{ x: number; y: number; z: number; k: string }> = [];
  const lampCells: Array<{ x: number; y: number; z: number; k: string }> = [];
  for (const [k, sp] of redstoneCells) {
    const [x, y, z] = k.split(",").map(Number);
    if (sp === "torch" || (sp === "lever" && leverOn.has(k))) sources.push({ x, y, z, k });
    else if (sp === "dust") dustCells.push({ x, y, z, k });
    else if (sp === "lamp") lampCells.push({ x, y, z, k });
  }
  // BFS: 电源经红石粉传导
  const powered = new Set<string>();
  const visited = new Set<string>(sources.map(s => s.k));
  const queue = sources.slice();
  while (queue.length) {
    const cur = queue.shift()!;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const nx = cur.x + dx, ny = cur.y + dy, nz = cur.z + dz;
      if (getBlock(nx, ny, nz) !== B.DUST) continue;
      const k = keyOf(nx, ny, nz);
      if (visited.has(k)) continue;
      visited.add(k); powered.add(k);
      queue.push({ x: nx, y: ny, z: nz, k });
    }
  }
  const powered6 = (x: number, y: number, z: number): boolean => {
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const k = keyOf(x + dx, y + dy, z + dz);
      if (powered.has(k) || sources.some(s => s.k === k)) return true;
    }
    return false;
  };
  for (const c of dustCells) {
    const on = powered.has(c.k);
    const was = dustOn.has(c.k);
    if (on !== was) {
      if (on) dustOn.add(c.k); else dustOn.delete(c.k);
      removeInstance(c.k); spawnInstance(c.k, c.x, c.y, c.z);
    }
  }
  for (const c of lampCells) {
    const lit = powered6(c.x, c.y, c.z);
    const was = lampLit.has(c.k);
    if (lit !== was) {
      if (lit) lampLit.add(c.k); else lampLit.delete(c.k);
      removeInstance(c.k); spawnInstance(c.k, c.x, c.y, c.z);
    }
  }
}
export function toggleLeverAt(x: number, y: number, z: number): boolean {
  if (getBlock(x, y, z) !== B.LEVER) return false;
  const k = keyOf(x, y, z);
  if (leverOn.has(k)) leverOn.delete(k); else leverOn.add(k);
  removeInstance(k); spawnInstance(k, x, y, z);
  recomputeRedstone();
  return true;
}

// ---------- 破坏 / 放置 ----------
export function breakBlock(x: number, y: number, z: number): BlockDef | null {
  const id = getBlock(x, y, z);
  const def = DEFS[id];
  if (id === B.AIR || !def.breakable) return null;
  setBlockData(x, y, z, B.AIR);
  updateRedstoneRegistry(x, y, z);
  updateInstancesAt(x, y, z);
  if (redstoneNearby(x, y, z)) recomputeRedstone();
  return def;
}
export function placeBlock(x: number, y: number, z: number, id: number): { ok: boolean; msg: string } {
  if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ)
    return { ok: false, msg: "超出世界边界" };
  if (y > BUILD_LIMIT) return { ok: false, msg: `超出建筑高度上限 (y>${BUILD_LIMIT})` };
  if (getBlock(x, y, z) !== B.AIR) return { ok: false, msg: "目标位置已有方块" };
  if (DEFS[id].special && !isSolid(x, y - 1, z))
    return { ok: false, msg: "红石元件需要放在方块顶部" };
  setBlockData(x, y, z, id);
  updateRedstoneRegistry(x, y, z);
  updateInstancesAt(x, y, z);
  if (redstoneNearby(x, y, z)) recomputeRedstone();
  return { ok: true, msg: "" };
}
// 多人: 应用服务器下发的方块变更（只更新本地世界, 不再回传）
export function setBlockRemote(x: number, y: number, z: number, id: number): void {
  if (x < 0 || y < 0 || z < 0 || x >= SX || y >= SY || z >= SZ) return;
  setBlockData(x, y, z, id);
  updateRedstoneRegistry(x, y, z);
  updateInstancesAt(x, y, z);
  recomputeRedstone();
}

// ---------- 体素射线 (DDA) ----------
export interface BlockHit {
  x: number; y: number; z: number;
  px: number; py: number; pz: number;   // 命中前一格(放置位)
  dist: number;
}
export function raycastBlock(origin: BABYLON.Vector3, dir: BABYLON.Vector3,
                             maxDist = 7): BlockHit | null {
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
  const tdx = Math.abs(1 / dir.x), tdy = Math.abs(1 / dir.y), tdz = Math.abs(1 / dir.z);
  let tmx = tdx * (dir.x > 0 ? x + 1 - origin.x : origin.x - x);
  let tmy = tdy * (dir.y > 0 ? y + 1 - origin.y : origin.y - y);
  let tmz = tdz * (dir.z > 0 ? z + 1 - origin.z : origin.z - z);
  // 使用标量记录上一格，避免每帧的射线检测产生对象分配
  let px = x, py = y, pz = z, hasPrev = false;
  let t = 0;
  for (let i = 0; i < 160 && t <= maxDist; i++) {
    if (isTargetable(x, y, z)) {
      return { x, y, z, px: hasPrev ? px : x, py: hasPrev ? py : y, pz: hasPrev ? pz : z, dist: t };
    }
    px = x; py = y; pz = z; hasPrev = true;
    if (tmx < tmy && tmx < tmz) { x += stepX; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += stepY; t = tmy; tmy += tdy; }
    else { z += stepZ; t = tmz; tmz += tdz; }
  }
  return null;
}

// ---------- 地形 / 村庄生成 ----------
/** 已生成的村庄位置（调试/截图用） */
export const villageSites: Array<{ x: number; z: number; base: number }> = [];

export function generateWorld(): void {
  atlas = makeAtlas();
  glassTex = makeGlassTexture();
  buildSpecialMasters();
  initPlantMaterial();
  // 区块网格共享材质：整张图集一个材质 → 所有区块网格都能合批/复用同一 shader
  terrainMat = new BABYLON.StandardMaterial("matTerrain", scene);
  terrainMat.diffuseTexture = atlas;
  terrainMat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
  terrainMat.freeze();                       // 材质参数静态，免去每帧脏检查
  glassChunkMat = new BABYLON.StandardMaterial("matGlassChunk", scene);
  glassChunkMat.diffuseTexture = glassTex;
  glassChunkMat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
  glassChunkMat.backFaceCulling = false;
  // 注意：不要 freeze() 透明材质，实测无收益（见 docs/PERFORMANCE.md）
  // 只有萤石保留实例（自发光材质与图集不同）
  masters.set(B.GLOWSTONE, buildBlockMesh(B.GLOWSTONE));
  const rng = mulberry32(20261010);
  const heights = new Int16Array(SX * SZ);
  const biomes = new Uint8Array(SX * SZ);   // 0平原 1森林 2沙漠 3山地 4雪原
  const SEA = SEA_LEVEL;
  const oreAt = (h: number, y: number): number => {
    const r = rng();
    if (y < 10 && r < 0.006) return B.DIAMOND_ORE;
    if (y < 16 && r < 0.010) return B.EMERALD_ORE;
    if (y < 24 && r < 0.015) return B.GOLD_ORE;
    if (y < 36 && r < 0.022) return B.IRON_ORE;
    if (y < 48 && r < 0.030) return B.COAL_ORE;
    if (y > h - 9 && r < 0.07) return B.MOSSY_COBBLE;
    if (r < 0.10) return B.GRAVEL;
    return B.STONE;
  };
  // ---------- 1) 高度图：域扭曲 + 大陆/丘陵/山脊多层叠加 ----------
  const raw = new Float32Array(SX * SZ);
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const hi = x + z * SX;
      // 域扭曲：把采样坐标本身揉弯，山脉走向不再是噪声网格的正交条纹
      const wx = x + (valueNoise(x / 54, z / 54, 411) - 0.5) * 34;
      const wz = z + (valueNoise(x / 54, z / 54, 412) - 0.5) * 34;
      const cont = fbmS(wx, wz, 17, 96, 4);            // 大陆度（低值 = 海洋）
      const hills = fbmS(wx, wz, 53, 26, 3);           // 丘陵细节
      const mtn = smoothstep01((fbmS(x, z, 777, 84, 2) - 0.50) / 0.24);  // 山脉权重 0..1
      const ridge = ridgedFbm(wx, wz, 321, 44, 4);     // 折叠山脊
      // 陆地权重：大陆度低处下沉成海，海岸线由平滑过渡带自然形成
      const land = smoothstep01((cont - 0.40) / 0.16);
      const seabed = 3 + cont * 12;                    // 海底缓坡
      const baseLand = 10 + cont * 10 + hills * 8;     // 平原/丘陵
      // 山脚缓坡 + 山顶高耸：ridge^1.35 让山谷平坦、山脊陡立
      const h = seabed * (1 - land) + baseLand * land
              + Math.pow(ridge, 1.35) * 34 * mtn + mtn * 2;
      raw[hi] = h;
      // 生物群系：山脉优先，其余按低频噪声分区
      const bN = valueNoise(x / 80, z / 80, 9001);
      let biome: number;
      if (mtn > 0.45) biome = 3;          // 山地
      else if (bN < 0.22) biome = 2;      // 沙漠
      else if (bN < 0.46) biome = 0;      // 平原
      else if (bN < 0.72) biome = 1;      // 森林
      else biome = 4;                     // 雪原
      biomes[hi] = biome;
    }
  }
  // ---------- 2) 两遍邻域平滑：削掉噪声尖刺，同时保留大半山脊 ----------
  const smoothBuf = new Float32Array(SX * SZ);
  for (let pass = 0; pass < 2; pass++) {
    for (let z = 0; z < SZ; z++)
      for (let x = 0; x < SX; x++) {
        const hi = x + z * SX;
        let sum = 0, cnt = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx, zz = z + dz;
            if (xx < 0 || zz < 0 || xx >= SX || zz >= SZ) continue;
            sum += raw[xx + zz * SX]; cnt++;
          }
        smoothBuf[hi] = raw[hi] * 0.45 + (sum / cnt) * 0.55;
      }
    raw.set(smoothBuf);
  }
  // ---------- 3) 写方块：地表材质由海拔、坡度、群系共同决定 ----------
  for (let z = 0; z < SZ; z++) {
    for (let x = 0; x < SX; x++) {
      const hi = x + z * SX;
      const biome = biomes[hi];
      // 细碎起伏：打散"整数高度"造成的规则阶梯，让坡面和海岸线不那么像等高线模型
      const fineN = fbmS(x, z, 913, 9, 2);
      const h = Math.max(3, Math.min(SY - 9, Math.round(raw[hi] + (fineN - 0.5) * 1.8)));
      heights[hi] = h;
      // 坡度：用于悬崖裸岩与雪线判断
      const slopeX = Math.abs(raw[Math.min(SX - 1, x + 1) + z * SX] - raw[Math.max(0, x - 1) + z * SX]);
      const slopeZ = Math.abs(raw[x + Math.min(SZ - 1, z + 1) * SX] - raw[x + Math.max(0, z - 1) * SX]);
      const slope = Math.max(slopeX, slopeZ);
      const beach = h <= SEA + 1;
      for (let y = 0; y < h; y++) {
        let t: number;
        if (y === 0) t = B.BEDROCK;
        else if (y < h - 4) t = oreAt(h, y);
        else if (y < h - 1) {
          if (biome === 2 || beach) t = rng() < 0.35 ? B.SAND : B.SANDSTONE;
          else if (slope > 2.4) t = B.STONE;
          else t = B.DIRT;
        } else {
          if (beach) t = B.SAND;
          else if (biome === 2) t = rng() < 0.85 ? B.SAND : B.SANDSTONE;
          else if (h >= 44) t = B.SNOW;                                   // 高山雪线
          else if (slope > 2.2) t = rng() < 0.22 ? B.COBBLE : B.STONE;    // 陡坡裸岩
          else if (biome === 3) t = h >= 34 ? B.SNOW : rng() < 0.5 ? B.STONE : B.MOSSY_COBBLE;
          else if (biome === 4) t = rng() < 0.75 ? B.SNOW : B.GRASS;
          else t = B.GRASS;
        }
        setBlockData(x, y, z, t);
      }
      // 低洼灌水（湖泊 / 海洋）
      for (let y = h; y < SEA; y++) setBlockData(x, y, z, B.WATER);
      // 浅水黏土
      if (h <= 10 && h > 4) {
        for (let y = h - 3; y < h - 1; y++)
          if (rng() < 0.35 && getBlock(x, y, z) === B.STONE) setBlockData(x, y, z, B.CLAY);
      }
    }
  }
  // 仙人掌（沙漠）
  for (let i = 0; i < 160; i++) {
    const x = 3 + ((rng() * (SX - 6)) | 0);
    const z = 3 + ((rng() * (SZ - 6)) | 0);
    const hi = x + z * SX;
    if (biomes[hi] !== 2) continue;
    const h = heights[hi];
    if (h <= SEA + 1 || getBlock(x, h - 1, z) !== B.SAND || getBlock(x, h, z) !== B.AIR) continue;
    const tall = 1 + ((rng() * 3) | 0);
    for (let k = 0; k < tall; k++) if (getBlock(x, h + k, z) === B.AIR) setBlockData(x, h + k, z, B.CACTUS);
  }
  // 树木（森林最密，平原稀疏，雪原少量）
  let treeCount = 0;
  for (let i = 0; i < 2200 && treeCount < 280; i++) {
    const x = 3 + ((rng() * (SX - 6)) | 0);
    const z = 3 + ((rng() * (SZ - 6)) | 0);
    const hi = x + z * SX;
    const b = biomes[hi], h = heights[hi];
    if (h <= SEA + 1 || h > SY - 12) continue;
    if (getBlock(x, h - 1, z) !== B.GRASS || getBlock(x, h, z) !== B.AIR) continue;
    const chance = b === 1 ? 0.6 : b === 0 ? 0.2 : b === 4 ? 0.14 : 0.05;
    if (rng() > chance) continue;
    let crowded = false;
    for (let dx = -2; dx <= 2 && !crowded; dx++)
      for (let dz = -2; dz <= 2; dz++) if (getBlock(x + dx, h, z + dz) === B.LOG) { crowded = true; break; }
    if (crowded) continue;
    const big = b === 1 && rng() < 0.45;
    buildTree(x, h, z, big ? 6 + ((rng() * 3) | 0) : 4 + ((rng() * 2) | 0), big ? 3 : 2);
    treeCount++;
  }
  // 地物：高草与野花（草 4 变体 / 花 10 变体，按坐标哈希挑选）
  for (let i = 0; i < 14000; i++) {
    const x = 2 + ((rng() * (SX - 4)) | 0);
    const z = 2 + ((rng() * (SZ - 4)) | 0);
    const hi = x + z * SX;
    const b = biomes[hi], h = heights[hi];
    if (h <= SEA + 1 || h >= SY - 3) continue;
    const below = getBlock(x, h - 1, z);
    if ((below !== B.GRASS && below !== B.DIRT) || getBlock(x, h, z) !== B.AIR) continue;
    const r = rng();
    const flowerChance = b === 1 ? 0.16 : b === 0 ? 0.18 : b === 4 ? 0.03 : 0.02;
    const grassChance = b === 4 ? 0.10 : 0.42;
    if (r < flowerChance) setBlockData(x, h, z, B.FLOWER);
    else if (r < flowerChance + grassChance) setBlockData(x, h, z, B.TALL_GRASS);
  }
  // 村庄
  const sites: Array<{ x: number; z: number; base: number }> = [];
  for (let attempt = 0; attempt < 400 && sites.length < 6; attempt++) {
    const cx = 20 + ((rng() * (SX - 40)) | 0);
    const cz = 20 + ((rng() * (SZ - 40)) | 0);
    const base = heights[cx + cz * SX];
    // 村庄必须高于海平面，否则 flatten 会在海里挖出一个干坑
    if (base < SEA + 2 || base > 28) continue;
    let mn = 99, mx = 0;
    for (let dx = -10; dx <= 10; dx++)
      for (let dz = -10; dz <= 10; dz++) {
        const xx = Math.min(SX - 1, Math.max(0, cx + dx));
        const zz = Math.min(SZ - 1, Math.max(0, cz + dz));
        const h = heights[xx + zz * SX];
        mn = Math.min(mn, h); mx = Math.max(mx, h);
      }
    if (mx - mn > 6) continue;
    if (sites.some(s => Math.abs(s.x - cx) + Math.abs(s.z - cz) < 42)) continue;
    sites.push({ x: cx, z: cz, base });
  }
  for (const s of sites) {
    villageSites.push(s);
    buildVillage(s.x, s.z, s.base);
  }

  // 水面网格必须在所有方块（含村庄水井/水渠）落位后一次性构建
  buildWaterSurface();
}
function buildTree(x: number, y: number, z: number, trunk: number, radius: number): void {
  for (let i = 0; i < trunk; i++) setBlockData(x, y + i, z, B.LOG);
  const top = y + trunk;
  for (let dy = -2; dy <= 1; dy++) {
    const rr = dy >= 1 ? 1 : radius;
    for (let dx = -rr; dx <= rr; dx++)
      for (let dz = -rr; dz <= rr; dz++) {
        if (Math.abs(dx) === rr && Math.abs(dz) === rr) continue;   // 削角
        const yy = top + dy;
        if (getBlock(x + dx, yy, z + dz) === B.AIR) setBlockData(x + dx, yy, z + dz, B.LEAVES);
      }
  }
  setBlockData(x, top, z, B.LEAVES);
}

// ---------- 村庄构件 ----------
type DoorSide = "n" | "s" | "e" | "w";
interface HouseSpec { x: number; z: number; w: number; d: number; v: number; door: DoorSide; }

const inWorld = (x: number, z: number): boolean => x >= 0 && z >= 0 && x < SX && z < SZ;
function setIfAir(x: number, y: number, z: number, id: number): void {
  if (getBlock(x, y, z) === B.AIR) setBlockData(x, y, z, id);
}
/** 该列最高的"空"层（即地表上方一格） */
function columnTop(x: number, z: number): number {
  for (let y = SY - 1; y > 0; y--) {
    const id = getBlock(x, y, z);
    if (id === B.LOG || id === B.LEAVES) continue;   // 忽略树木，只看地形
    if (DEFS[id].solid) return y + 1;
  }
  return 1;
}
/**
 * 平整村庄地块：中心完全压平，外圈按距离平滑过渡回原地形，
 * 避免出现"悬空方台 + 垂直断崖"。过渡区下限为海平面以上，防止把海岸挖成干坑。
 */
function flattenArea(cx: number, cz: number, rad: number, base: number): void {
  const inner = Math.max(2, rad - 5);
  for (let x = cx - rad; x <= cx + rad; x++)
    for (let z = cz - rad; z <= cz + rad; z++) {
      if (!inWorld(x, z)) continue;
      const dist = Math.max(Math.abs(x - cx), Math.abs(z - cz));
      const t = dist <= inner ? 0 : Math.min(1, (dist - inner) / (rad - inner));
      let target = Math.round(base * (1 - t) + columnTop(x, z) * t);
      if (target < SEA_LEVEL + 1) target = SEA_LEVEL + 1;
      for (let y = target; y < SY; y++) setBlockData(x, y, z, B.AIR);
      for (let y = 1; y <= target - 1; y++) {
        const cur = getBlock(x, y, z);
        if (cur === B.AIR || cur === B.WATER)
          setBlockData(x, y, z, y < target - 5 ? B.STONE : B.DIRT);
      }
      setBlockData(x, target - 1, z, B.GRASS);
    }
}
/** 铺石板路：圆石/苔石混铺，并清掉上方的草与雪 */
function pave(x: number, z: number, base: number): void {
  if (!inWorld(x, z)) return;
  setBlockData(x, base, z, B.AIR);
  setBlockData(x, base + 1, z, B.AIR);
  setBlockData(x, base - 1, z, (x * 7 + z * 13) % 11 < 2 ? B.MOSSY_COBBLE : B.COBBLE);
}
/** L 形路径（先沿 z 再沿 x） */
function paveLine(x0: number, z0: number, x1: number, z1: number, base: number): void {
  let x = x0, z = z0;
  const sx = x1 >= x0 ? 1 : -1, sz = z1 >= z0 ? 1 : -1;
  while (z !== z1) { pave(x, z, base); z += sz; }
  while (x !== x1) { pave(x, z, base); x += sx; }
  pave(x, z, base);
}
/** 木柱 + 萤石路灯 */
function lampPost(x: number, z: number, base: number, h = 3): void {
  if (!inWorld(x, z)) return;
  for (let y = base; y < base + h; y++) setBlockData(x, y, z, B.LOG);
  setBlockData(x, base + h, z, B.GLOWSTONE);
}

/** 房屋：3 种形制（0 小屋 / 1 长屋 / 2 石作坊），人字阶梯屋顶 + 烟囱 + 室内陈设 */
function buildHouse(spec: HouseSpec, base: number): void {
  const { x: x0, z: z0, w, d, v, door } = spec;
  const wallH = v === 2 ? 3 : 4;   // 墙更高，屋顶才不会把整栋房子压成一块"大红砖"
  const wallMat = v === 2 ? B.COBBLE : B.PLANKS;
  const roofMat = v === 1 ? B.BRICKS : B.PLANKS;
  const floorMat = v === 2 ? B.COBBLE : B.PLANKS;

  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++) {
      for (let y = base; y <= base + wallH + 4; y++) setBlockData(x0 + dx, y, z0 + dz, B.AIR);
      setBlockData(x0 + dx, base - 1, z0 + dz, floorMat);      // 地板
    }

  const doorX = door === "e" ? x0 + w - 1 : door === "w" ? x0 : x0 + (w >> 1);
  const doorZ = door === "s" ? z0 + d - 1 : door === "n" ? z0 : z0 + (d >> 1);

  // 墙体 + 窗
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++) {
      const edgeX = dx === 0 || dx === w - 1;
      const edgeZ = dz === 0 || dz === d - 1;
      if (!edgeX && !edgeZ) continue;
      const x = x0 + dx, z = z0 + dz;
      const corner = edgeX && edgeZ;
      const isDoor = x === doorX && z === doorZ;
      const window = !corner && (edgeX ? dz % 3 === 1 : dx % 3 === 1);
      for (let y = base; y < base + wallH; y++) {
        if (isDoor && y < base + 2) { setBlockData(x, y, z, B.AIR); continue; }
        if (corner) setBlockData(x, y, z, B.COBBLE);
        else if (window && (y === base + 1 || (wallH === 3 && y === base + 2)))
          setBlockData(x, y, z, B.GLASS);
        else setBlockData(x, y, z, wallMat);
      }
    }

  // 人字阶梯屋顶（沿长边起脊，向外挑 1 格）
  const gx = w >= d;
  const span = gx ? d : w;
  for (let i = 0; i < span; i++) {
    const lo = i - 1, hi = span + 1 - i;
    if (hi - lo <= 0) break;
    const y = base + wallH + i;
    if (gx) {
      for (let x = x0 - 1; x <= x0 + w; x++)
        for (let b = lo; b < hi; b++) setBlockData(x, y, z0 + b, roofMat);
    } else {
      for (let z = z0 - 1; z <= z0 + d; z++)
        for (let a = lo; a < hi; a++) setBlockData(x0 + a, y, z, roofMat);
    }
  }
  // 烟囱
  for (let y = base + wallH; y <= base + wallH + 3; y++)
    setBlockData(x0 + 1, y, z0 + 1, B.BRICKS);
  setBlockData(x0 + 1, base + wallH + 4, z0 + 1, B.GLOWSTONE);

  // 室内陈设
  const cxi = x0 + (w >> 1), czi = z0 + (d >> 1);
  setBlockData(cxi, base + wallH - 1, czi, B.GLOWSTONE);
  if (v === 0) {
    setBlockData(x0 + w - 2, base, z0 + 1, B.BOOKSHELF);
    setBlockData(x0 + w - 3, base, z0 + 1, B.BRICKS);
    setBlockData(x0 + 1, base, z0 + d - 2, B.PLANKS);
  } else if (v === 1) {
    setBlockData(x0 + 1, base + wallH - 1, z0 + 1, B.GLOWSTONE);
    setBlockData(x0 + w - 2, base + wallH - 1, z0 + d - 2, B.GLOWSTONE);
    for (let dz = 1; dz < d - 1; dz += 2) setBlockData(x0 + w - 2, base, z0 + dz, B.BOOKSHELF);
    for (let dx = 2; dx < w - 2; dx += 2) setBlockData(x0 + dx, base, czi, B.PLANKS);
  } else {
    setBlockData(x0 + 1, base, z0 + 1, B.LOG);
    setBlockData(x0 + w - 2, base, z0 + 1, B.LOG);
    setBlockData(x0 + 2, base, z0 + d - 2, B.PLANKS);
    setBlockData(x0 + 2, base + 1, z0 + d - 2, B.PLANKS);
    setBlockData(x0 + w - 3, base, z0 + d - 3, B.BOOKSHELF);
  }
  // 门口两侧花箱
  const ox = door === "n" || door === "s" ? 1 : 0;
  const oz = door === "e" || door === "w" ? 1 : 0;
  setIfAir(doorX - ox, base, doorZ - oz, B.FLOWER);
  setIfAir(doorX + ox, base, doorZ + oz, B.FLOWER);
}

/** 广场水井：石砌井口 + 井水 + 木架顶棚 + 挂灯 */
function buildWell(cx: number, cz: number, base: number): void {
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) {
      for (let y = base; y <= base + 2; y++) setBlockData(cx + dx, y, cz + dz, B.AIR);
      if (dx === 0 && dz === 0) {
        setBlockData(cx, base - 2, cz, B.COBBLE);
        setBlockData(cx, base - 1, cz, B.WATER);
      } else {
        setBlockData(cx + dx, base - 1, cz + dz, B.COBBLE);
        setBlockData(cx + dx, base, cz + dz, B.COBBLE);
      }
    }
  for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as Array<[number, number]>)
    for (let y = base + 1; y <= base + 4; y++) setBlockData(cx + dx, y, cz + dz, B.LOG);
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++) setBlockData(cx + dx, base + 5, cz + dz, B.PLANKS);
  setBlockData(cx, base + 4, cz, B.GLOWSTONE);
}

/** 农田：中间一条水渠，两侧土垄上种"作物"（复用高草），四周矮石墙 */
function buildFarm(x0: number, z0: number, base: number, w: number, d: number): void {
  for (let dx = 0; dx < w; dx++)
    for (let dz = 0; dz < d; dz++) {
      const x = x0 + dx, z = z0 + dz;
      if (!inWorld(x, z)) continue;
      for (let y = base; y <= base + 2; y++) setBlockData(x, y, z, B.AIR);
      const channel = dz === (d >> 1);
      setBlockData(x, base - 1, z, channel ? B.WATER : B.DIRT);
      if (!channel) setIfAir(x, base, z, B.TALL_GRASS);
    }
  for (let dx = -1; dx <= w; dx++)
    for (let dz = -1; dz <= d; dz++) {
      if (!(dx === -1 || dz === -1 || dx === w || dz === d)) continue;
      const x = x0 + dx, z = z0 + dz;
      if (!inWorld(x, z)) continue;
      setBlockData(x, base, z, B.AIR);
      setBlockData(x, base - 1, z, B.MOSSY_COBBLE);
      setIfAir(x, base, z, B.MOSSY_COBBLE);
    }
}

/** 集市摊位：四柱 + 木板顶棚 + 台面与货物 */
function buildStall(cx: number, cz: number, base: number): void {
  for (const [dx, dz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]] as Array<[number, number]>)
    for (let y = base; y <= base + 2; y++) setBlockData(cx + dx, y, cz + dz, B.LOG);
  for (let dx = -2; dx <= 2; dx++)
    for (let dz = -2; dz <= 2; dz++) {
      if (Math.abs(dx) !== 2 && Math.abs(dz) !== 2) continue;
      setBlockData(cx + dx, base + 3, cz + dz, B.PLANKS);
    }
  setBlockData(cx, base + 2, cz, B.GLOWSTONE);
  setBlockData(cx, base, cz, B.PLANKS);
  setBlockData(cx - 1, base, cz, B.BOOKSHELF);
  setBlockData(cx + 1, base, cz, B.BRICKS);
}

/** 村庄：广场 + 水井 + 4 栋房屋 + 石板路 + 农田 + 集市 + 路灯 + 花坛 */
function buildVillage(cx: number, cz: number, base: number): void {
  flattenArea(cx, cz, 15, base);

  // 广场：中心砖石、外圈圆石
  for (let dx = -3; dx <= 3; dx++)
    for (let dz = -3; dz <= 3; dz++) {
      const x = cx + dx, z = cz + dz;
      if (!inWorld(x, z)) continue;
      setBlockData(x, base, z, B.AIR);
      setBlockData(x, base + 1, z, B.AIR);
      const ring = Math.max(Math.abs(dx), Math.abs(dz)) === 3;
      setBlockData(x, base - 1, z, ring ? B.COBBLE : B.BRICKS);
    }
  buildWell(cx, cz, base);

  const houses: HouseSpec[] = [
    { x: cx - 12, z: cz - 12, w: 6, d: 5, v: 0, door: "s" },
    { x: cx + 6, z: cz - 12, w: 7, d: 5, v: 1, door: "s" },
    { x: cx - 11, z: cz + 6, w: 5, d: 6, v: 2, door: "n" },
    { x: cx + 5, z: cz + 6, w: 6, d: 6, v: 1, door: "n" },
  ];
  for (const h of houses) {
    buildHouse(h, base);
    const dx = h.door === "e" ? h.x + h.w : h.door === "w" ? h.x - 1 : h.x + (h.w >> 1);
    const dz = h.door === "s" ? h.z + h.d : h.door === "n" ? h.z - 1 : h.z + (h.d >> 1);
    paveLine(dx, dz, cx, cz + (dz > cz ? 4 : -4), base);
  }

  buildFarm(cx + 7, cz - 3, base, 5, 5);
  buildStall(cx - 7, cz - 1, base);
  for (const [lx, lz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]] as Array<[number, number]>)
    lampPost(cx + lx, cz + lz, base, 3);
  for (const [fx, fz] of [[-5, 0], [5, 1], [0, -5], [1, 5], [-6, 3], [6, -3]] as Array<[number, number]>) {
    const x = cx + fx, z = cz + fz;
    if (!inWorld(x, z)) continue;
    setBlockData(x, base, z, B.AIR);
    setIfAir(x, base, z, B.FLOWER);
  }
  // 长椅
  for (const [bx, bz] of [[-2, 5], [3, -5]] as Array<[number, number]>) {
    setBlockData(cx + bx, base, cz + bz, B.PLANKS);
    setBlockData(cx + bx + 1, base, cz + bz, B.PLANKS);
  }
}
