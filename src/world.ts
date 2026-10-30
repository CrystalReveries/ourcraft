/* 世界模块：体素数据、地形/村庄生成、图集纹理、网格与实例管理、红石系统 */
import * as BABYLON from "@babylonjs/core";
import { SX, SY, SZ, BUILD_LIMIT, B, DEFS, BlockDef, T } from "./config";
import { buildBoxGeometry, tileUV } from "./geometry";

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
const isTargetable = (x: number, y: number, z: number): boolean => getBlock(x, y, z) !== B.AIR;

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
function fbm(x: number, z: number, seed: number): number {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += valueNoise((x * freq) / 16, (z * freq) / 16, seed + o * 101) * amp;
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return sum / norm;
}

// ---------- 纹理图集（8列 x 3行, 64px/格） ----------
// tileUV 由 ./geometry 提供（纯函数，单元测试覆盖）
function makeAtlas(): BABYLON.DynamicTexture {
  const tile = 64;
  const tex = new BABYLON.DynamicTexture("atlas", { width: 512, height: 256 }, scene, true);
  tex.hasAlpha = false;   // 图集保持不透明: 开启 hasAlpha 会使所有方块进入透明管线, 产生深度排序漏洞
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
  noiseTile(T.grassTop, "#4f9e3a", ["#3f8a2e", "#5fb44a", "#448f31"], 900);
  noiseTile(T.grassSide, "#6b4f2e", ["#5a4226", "#7d5d38"], 500);
  noiseTile(T.dirt, "#7a5a38", ["#6a4d2f", "#8a6a45"], 800);
  noiseTile(T.stone, "#8a8a8a", ["#7a7a7a", "#9a9a9a", "#6e6e6e"], 800);
  noiseTile(T.sand, "#dbcf9a", ["#cfc189", "#e8ddab"], 700);
  noiseTile(T.logSide, "#6e5230", ["#5d4426", "#7f6138"], 400);
  noiseTile(T.logTop, "#a3814f", ["#8f6f40", "#b5935e"], 500);
  noiseTile(T.leaves, "#2e6b23", ["#245a1b", "#3d7d2e", "#1e4f16"], 900);
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

  // 草侧面顶部草皮
  {
    const r = tileUV(T.grassSide);
    const x0 = r.u0 * 512, y0 = (1 - r.v1) * 256;
    ctx.fillStyle = "#4f9e3a";
    ctx.fillRect(x0, y0, tile, 14);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = rng() < 0.5 ? "#3f8a2e" : "#5fb44a";
      ctx.fillRect(x0 + rng() * tile, y0 + 10 + rng() * 6, 3 + rng() * 3, 2 + rng() * 3);
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
const masters = new Map<number, BABYLON.Mesh>();   // 普通方块
let dustOffM!: BABYLON.Mesh, dustOnM!: BABYLON.Mesh;
let lampOffM!: BABYLON.Mesh, lampOnM!: BABYLON.Mesh;
let leverOffM!: BABYLON.Mesh, leverOnM!: BABYLON.Mesh;
let torchM!: BABYLON.Mesh;
const instances = new Map<string, BABYLON.InstancedMesh>();
const keyOf = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const dustOn = new Set<string>();
const lampLit = new Set<string>();
export const leverOn = new Set<string>();

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
  if (id === B.AIR) return;
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
function faceVisible(x: number, y: number, z: number): boolean {
  const id = getBlock(x, y, z);
  if (id === B.AIR) return false;
  if (DEFS[id].special) return true;
  return !DEFS[getBlock(x + 1, y, z)].opaque || !DEFS[getBlock(x - 1, y, z)].opaque ||
         !DEFS[getBlock(x, y + 1, z)].opaque || !DEFS[getBlock(x, y - 1, z)].opaque ||
         !DEFS[getBlock(x, y, z + 1)].opaque || !DEFS[getBlock(x, y, z - 1)].opaque;
}
export function updateInstancesAt(x: number, y: number, z: number): void {
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
  let prev: { x: number; y: number; z: number } | null = null;
  let t = 0;
  for (let i = 0; i < 160 && t <= maxDist; i++) {
    if (isTargetable(x, y, z)) {
      return { x, y, z, px: prev?.x ?? x, py: prev?.y ?? y, pz: prev?.z ?? z, dist: t };
    }
    prev = { x, y, z };
    if (tmx < tmy && tmx < tmz) { x += stepX; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += stepY; t = tmy; tmy += tdy; }
    else { z += stepZ; t = tmz; tmz += tdz; }
  }
  return null;
}

// ---------- 地形 / 村庄生成 ----------
export function generateWorld(): void {
  atlas = makeAtlas();
  glassTex = makeGlassTexture();
  buildSpecialMasters();
  for (const id of [B.GRASS, B.DIRT, B.STONE, B.SAND, B.LOG, B.LEAVES, B.PLANKS, B.COBBLE,
    B.BRICKS, B.GLASS, B.GLOWSTONE, B.BEDROCK, B.SNOW, B.BOOKSHELF, B.LAMP,
    B.EMERALD_ORE, B.DIAMOND_ORE, B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE,
    B.GRAVEL, B.CLAY, B.SANDSTONE, B.CACTUS, B.MOSSY_COBBLE]) {
    masters.set(id, buildBlockMesh(id));
  }
  const rng = mulberry32(20261010);
  const heights = new Int16Array(SX * SZ);
  for (let x = 0; x < SX; x++) {
    for (let z = 0; z < SZ; z++) {
      const n = fbm(x, z, 42);
      const h = Math.max(3, Math.min(SY - 16, Math.floor(3 + n * 26)));
      heights[x + z * SX] = h;
      for (let y = 0; y < h; y++) {
        let t: number;
        if (y === 0) t = B.BEDROCK;
        else if (y < h - 4) {
          t = B.STONE;
          const r = rng();
          if (y < 40 && r < 0.012) t = B.COAL_ORE;
          else if (y < 30 && r < 0.020) t = B.IRON_ORE;
          else if (y < 14 && r < 0.023) t = B.GOLD_ORE;
          else if (y < 12 && r < 0.025) t = B.EMERALD_ORE;
          else if (y < 8 && r < 0.027) t = B.DIAMOND_ORE;
          else if (y > h - 8 && r < 0.06) t = B.MOSSY_COBBLE;
          else if (r < 0.09) t = B.GRAVEL;
        }
        else if (y < h - 1) t = h <= 10 ? B.SANDSTONE : B.DIRT;
        else t = h <= 9 ? B.SAND : h >= 30 ? B.SNOW : B.GRASS;
        setBlockData(x, y, z, t);
      }
      // 低洼黏土层
      if (h <= 9 && h > 3) {
        for (let y = h - 3; y < h - 1; y++) {
          if (rng() < 0.3 && getBlock(x, y, z) === B.STONE) setBlockData(x, y, z, B.CLAY);
        }
      }
    }
  }
  // 仙人掌（沙滩）
  for (let i = 0; i < 80; i++) {
    const x = 3 + ((rng() * (SX - 6)) | 0);
    const z = 3 + ((rng() * (SZ - 6)) | 0);
    const h = heights[x + z * SX];
    if (h < 4 || h > 9 || getBlock(x, h - 1, z) !== B.SAND) continue;
    const tall = 1 + ((rng() * 2) | 0);
    for (let k = 0; k < tall; k++) {
      if (getBlock(x, h + k, z) === B.AIR) setBlockData(x, h + k, z, B.CACTUS);
    }
  }
  // 树
  for (let i = 0; i < 90; i++) {
    const x = 3 + ((rng() * (SX - 6)) | 0);
    const z = 3 + ((rng() * (SZ - 6)) | 0);
    const h = heights[x + z * SX];
    if (getBlock(x, h - 1, z) !== B.GRASS || h > SY - 14) continue;
    const trunk = 4 + ((rng() * 2) | 0);
    for (let y = 0; y < trunk; y++) setBlockData(x, h + y, z, B.LOG);
    const top = h + trunk;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++)
        for (let dy = -2; dy <= 0; dy++) {
          const r = Math.abs(dx) + Math.abs(dz) + Math.abs(dy);
          if (r > 3 || (Math.abs(dx) === 2 && Math.abs(dz) === 2 && dy < 0)) continue;
          if (getBlock(x + dx, top + dy, z + dz) === B.AIR) setBlockData(x + dx, top + dy, z + dz, B.LEAVES);
        }
    setBlockData(x, top, z, B.LEAVES);
    setBlockData(x, top + 1, z, B.LEAVES);
  }
  // 村庄
  const sites: Array<{ x: number; z: number; base: number }> = [];
  for (let attempt = 0; attempt < 200 && sites.length < 4; attempt++) {
    const cx = 16 + ((rng() * (SX - 32)) | 0);
    const cz = 16 + ((rng() * (SZ - 32)) | 0);
    const base = heights[cx + cz * SX];
    if (base < 8 || base > 24) continue;
    let mn = 99, mx = 0;
    for (let dx = -6; dx <= 6; dx++)
      for (let dz = -6; dz <= 6; dz++) {
        const h = heights[(cx + dx) + (cz + dz) * SX];
        mn = Math.min(mn, h); mx = Math.max(mx, h);
      }
    if (mx - mn > 3) continue;
    if (sites.some(s => Math.abs(s.x - cx) + Math.abs(s.z - cz) < 42)) continue;
    sites.push({ x: cx, z: cz, base });
  }
  for (const s of sites) buildVillage(s.x, s.z, s.base);
}
function flattenArea(cx: number, cz: number, rad: number, base: number): void {
  for (let x = cx - rad; x <= cx + rad; x++)
    for (let z = cz - rad; z <= cz + rad; z++) {
      if (x < 0 || z < 0 || x >= SX || z >= SZ) continue;
      for (let y = base; y < SY; y++) setBlockData(x, y, z, B.AIR);
      for (let y = 1; y <= base - 2; y++) if (getBlock(x, y, z) === B.AIR)
        setBlockData(x, y, z, y < base - 5 ? B.STONE : B.DIRT);
      setBlockData(x, base - 1, z, B.GRASS);
    }
}
function buildHouse(x0: number, z0: number, base: number): void {
  for (let dx = 0; dx < 5; dx++)
    for (let dz = 0; dz < 5; dz++) {
      for (let y = base; y <= base + 4; y++) setBlockData(x0 + dx, y, z0 + dz, B.AIR);
      setBlockData(x0 + dx, base - 1, z0 + dz, B.PLANKS);      // 地板
      setBlockData(x0 + dx, base + 3, z0 + dz, B.PLANKS);      // 屋顶
    }
  for (let dx = 0; dx < 5; dx++)
    for (let dz = 0; dz < 5; dz++) {
      const edge = dx === 0 || dx === 4 || dz === 0 || dz === 4;
      if (!edge) continue;
      const corner = (dx === 0 || dx === 4) && (dz === 0 || dz === 4);
      for (let y = base; y <= base + 2; y++) {
        if (corner) setBlockData(x0 + dx, y, z0 + dz, B.COBBLE);
        else if (y === base + 1 && ((dx === 0 || dx === 4) && dz === 2 || (dz === 0 || dz === 4) && dx === 2))
          setBlockData(x0 + dx, y, z0 + dz, B.GLASS);          // 窗
        else setBlockData(x0 + dx, y, z0 + dz, B.PLANKS);
      }
    }
  setBlockData(x0 + 2, base, z0, B.AIR);                       // 门(下)
  setBlockData(x0 + 2, base + 1, z0, B.AIR);                   // 门(上)
  setBlockData(x0 + 2, base + 2, z0 + 2, B.GLOWSTONE);         // 室内灯
  setBlockData(x0 + 3, base, z0 + 3, B.BOOKSHELF);             // 装饰书架
  setBlockData(x0 + 1, base, z0 + 3, B.BRICKS);
}
function buildWell(cx: number, cz: number, base: number): void {
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) {
      for (let y = base; y <= base + 2; y++) setBlockData(cx + dx, y, cz + dz, B.AIR);
      if (dx === 0 && dz === 0) {
        setBlockData(cx, base - 1, cz, B.AIR);
        setBlockData(cx, base - 2, cz, B.COBBLE);
      } else {
        setBlockData(cx + dx, base - 1, cz + dz, B.COBBLE);
        setBlockData(cx + dx, base, cz + dz, B.COBBLE);
      }
    }
}
function buildVillage(cx: number, cz: number, base: number): void {
  flattenArea(cx, cz, 11, base);
  for (const [ox, oz] of [[-9, -9], [4, -9], [-9, 4], [4, 4]] as Array<[number, number]>)
    buildHouse(cx + ox, cz + oz, base);
  buildWell(cx, cz, base);
  // 路灯
  for (const [lx, lz] of [[cx + 7, cz + 1], [cx - 7, cz - 1]]) {
    for (let y = base; y <= base + 2; y++) setBlockData(lx, y, lz, B.LOG);
    setBlockData(lx, base + 3, lz, B.GLOWSTONE);
  }
}
