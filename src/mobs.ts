/* 生物系统：多部件模型 + 程序化贴图 + 行走动画 + A* 寻路
 * 规则：生物不能跳跃（寻路只允许平走与下落），伤害数值较低。
 */
import * as BABYLON from "@babylonjs/core";
import { SX, SZ, B } from "./config";
import { boxCollides, surfaceY, isSolid, getBlock } from "./world";
import { buildBoxGeometry6 } from "./geometry";

export interface MobDrop { id: string; min: number; max: number; }
export interface MobTypeDef {
  key: string;
  name: string;
  w: number; h: number;          // 精确 AABB
  color: string;
  hostile: boolean;
  hp: number;
  speed: number;
  damage: number;                // 对玩家伤害（已削弱）
  coins: number;
  drops: MobDrop[];
}

export const MOB_TYPES: Record<string, MobTypeDef> = {
  pig: {
    key: "pig", name: "猪", w: 0.9, h: 0.9, color: "#e8a2a8", hostile: false,
    hp: 10, speed: 1.3, damage: 0, coins: 2,
    drops: [{ id: "food:porkchop", min: 1, max: 2 }],
  },
  sheep: {
    key: "sheep", name: "羊", w: 0.9, h: 1.2, color: "#eeeeee", hostile: false,
    hp: 8, speed: 1.1, damage: 0, coins: 2,
    drops: [{ id: "food:mutton", min: 1, max: 2 }],
  },
  chicken: {
    key: "chicken", name: "鸡", w: 0.4, h: 0.7, color: "#f5f0e0", hostile: false,
    hp: 4, speed: 1.2, damage: 0, coins: 1,
    drops: [{ id: "food:chicken", min: 1, max: 1 }],
  },
  cow: {
    key: "cow", name: "牛", w: 1.1, h: 1.4, color: "#8a6a4a", hostile: false,
    hp: 12, speed: 1.0, damage: 0, coins: 3,
    drops: [{ id: "food:beef", min: 1, max: 2 }],
  },
  zombie: {
    key: "zombie", name: "僵尸", w: 0.6, h: 1.9, color: "#4e9a4e", hostile: true,
    hp: 18, speed: 2.2, damage: 1, coins: 8,
    drops: [{ id: "mat:coal", min: 0, max: 1 }],
  },
  spider: {
    key: "spider", name: "蜘蛛", w: 1.4, h: 0.9, color: "#2a2a2a", hostile: true,
    hp: 14, speed: 2.6, damage: 1, coins: 6,
    drops: [{ id: "food:chicken", min: 0, max: 1 }],
  },
};
export type MobKey = keyof typeof MOB_TYPES;

interface Mob {
  type: MobTypeDef;
  root: BABYLON.TransformNode;
  legs: BABYLON.TransformNode[];
  hitbox: BABYLON.LinesMesh;
  pos: BABYLON.Vector3;
  vel: BABYLON.Vector3;
  yaw: number;
  hp: number;
  onGround: boolean;
  wanderTimer: number;
  wanderDir: number;
  path: Array<{ x: number; y: number; z: number }> | null;
  pathIdx: number;
  repathTimer: number;
  attackCd: number;
  phase: number;
  moving: boolean;
}

let scene!: BABYLON.Scene;
const mobs: Mob[] = [];
let showHitboxes = false;

// ---------- 材质与模型 ----------
interface TypeMaterials {
  body: BABYLON.StandardMaterial;
  head: BABYLON.StandardMaterial;
  limbs: BABYLON.StandardMaterial;
  accent: BABYLON.StandardMaterial;
}
const materials = new Map<string, TypeMaterials>();

// 头部专用底色（让面部=/=身体颜色，更接近写实动物）
function headColor(key: string, base: string): string {
  switch (key) {
    case "sheep": return "#e0dacd";
    case "cow": return "#7a5a3f";
    case "zombie": return "#6f9e5f";
    case "spider": return "#262626";
    case "chicken": return "#f0e8d0";
    case "pig": return "#e8b0b4";
    default: return base;
  }
}

// 只画正脸的五官（眼睛/鼻子/嘴），其它面保持纯色
function drawFace(c: CanvasRenderingContext2D, type: MobTypeDef, ox: number, oy: number, s: number): void {
  const key = type.key;
  const X = (u: number): number => ox + u * s;
  const Y = (v: number): number => oy + v * s;
  const hostile = type.hostile;
  const eyeDark = hostile ? "#c0261c" : "#20201f";

  if (key === "spider") {
    c.fillStyle = "#1a1a1a";
    c.beginPath(); c.ellipse(X(0.5), Y(0.44), s * 0.3, s * 0.26, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#e03022";
    for (const [u, v, r] of [[0.32, 0.38, 0.07], [0.5, 0.33, 0.06], [0.68, 0.38, 0.07], [0.5, 0.52, 0.05]] as Array<[number, number, number]>) {
      c.beginPath(); c.arc(X(u), Y(v), s * r, 0, Math.PI * 2); c.fill();
    }
  } else {
    for (const u of [0.33, 0.67]) {
      c.fillStyle = "rgba(246,246,240,0.95)";
      c.beginPath(); c.ellipse(X(u), Y(0.43), s * 0.1, s * 0.12, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = eyeDark;
      c.beginPath(); c.ellipse(X(u), Y(0.44), s * 0.055, s * 0.075, 0, 0, Math.PI * 2); c.fill();
      c.fillStyle = "rgba(255,255,255,0.85)";
      c.beginPath(); c.arc(X(u) - s * 0.02, Y(0.41), s * 0.018, 0, Math.PI * 2); c.fill();
    }
    c.strokeStyle = hostile ? "rgba(40,20,20,0.8)" : "rgba(40,35,30,0.5)";
    c.lineWidth = Math.max(1, s * 0.03);
    for (const u of [0.33, 0.67]) {
      c.beginPath();
      c.moveTo(X(u) - s * 0.11, Y(hostile ? 0.3 : 0.32));
      c.lineTo(X(u) + s * 0.11, Y(hostile ? 0.37 : 0.33));
      c.stroke();
    }
  }

  if (key === "pig") {
    c.fillStyle = "#d99098";
    c.beginPath(); c.ellipse(X(0.5), Y(0.67), s * 0.16, s * 0.11, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#8a4a52";
    c.beginPath(); c.ellipse(X(0.44), Y(0.67), s * 0.03, s * 0.045, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(X(0.56), Y(0.67), s * 0.03, s * 0.045, 0, 0, Math.PI * 2); c.fill();
  } else if (key === "cow") {
    c.fillStyle = "#d8c8b0";
    c.beginPath(); c.ellipse(X(0.5), Y(0.69), s * 0.18, s * 0.12, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = "#6a4a36";
    c.beginPath(); c.arc(X(0.43), Y(0.69), s * 0.028, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(X(0.57), Y(0.69), s * 0.028, 0, Math.PI * 2); c.fill();
  } else if (key === "chicken") {
    c.fillStyle = "#e8a020";
    c.beginPath();
    c.moveTo(X(0.5), Y(0.56));
    c.lineTo(X(0.42), Y(0.67));
    c.lineTo(X(0.58), Y(0.67));
    c.closePath(); c.fill();
  } else if (key === "zombie") {
    c.fillStyle = "#3a2a2a";
    c.fillRect(X(0.36), Y(0.63), s * 0.28, s * 0.06);
    c.fillStyle = "#d8d8d0";
    for (let i = 0; i < 4; i++) c.fillRect(X(0.39 + i * 0.06), Y(0.63), s * 0.03, s * 0.035);
  } else if (key === "sheep") {
    c.strokeStyle = "rgba(50,45,40,0.6)";
    c.lineWidth = Math.max(1, s * 0.03);
    c.beginPath(); c.moveTo(X(0.44), Y(0.67)); c.lineTo(X(0.56), Y(0.67)); c.stroke();
  }
}

// 4x2 头贴图网格：0=正面(五官) 1=后面 2=左 3=右 4=顶 5=底
function faceAtlas(type: MobTypeDef): BABYLON.DynamicTexture {
  const cell = 64, cols = 4, rows = 2;
  const tex = new BABYLON.DynamicTexture("face_" + type.key, { width: cell * cols, height: cell * rows }, scene, true);
  tex.hasAlpha = false;
  const c = tex.getContext() as CanvasRenderingContext2D;
  const headCol = headColor(type.key, type.color);
  c.fillStyle = headCol;
  c.fillRect(0, 0, cell * cols, cell * rows);
  const shades: Array<[number, number]> = [[1, 0.88], [2, 0.93], [3, 0.93], [4, 1.06], [5, 0.82]];
  for (const [ci, f] of shades) {
    const cx = (ci % cols) * cell, cy = Math.floor(ci / cols) * cell;
    c.fillStyle = shade(headCol, f);
    c.fillRect(cx, cy, cell, cell);
    for (let i = 0; i < 80; i++) {
      c.fillStyle = shade(headCol, f * (0.9 + Math.random() * 0.22));
      c.fillRect(cx + Math.random() * cell, cy + Math.random() * cell, 2 + Math.random() * 3, 2 + Math.random() * 3);
    }
  }
  drawFace(c, type, 0, 0, cell);
  tex.update();
  return tex;
}

function flatMat(name: string, hex: string, emissive = 0): BABYLON.StandardMaterial {
  const m = new BABYLON.StandardMaterial(name, scene);
  m.diffuseColor = BABYLON.Color3.FromHexString(hex);
  m.specularColor = BABYLON.Color3.Black();
  if (emissive > 0) m.emissiveColor = BABYLON.Color3.FromHexString(hex).scale(emissive);
  return m;
}

function buildMaterials(): void {
  for (const key of Object.keys(MOB_TYPES)) {
    const t = MOB_TYPES[key];
    const body = flatMat("mobBody_" + key, t.color);
    const head = flatMat("mobHead_" + key, "#ffffff");
    head.diffuseTexture = faceAtlas(t);
    head.diffuseColor = new BABYLON.Color3(1, 1, 1);
    const limbs = flatMat("mobLimbs_" + key, shade(t.color, 0.75));
    const accent = flatMat("mobAccent_" + key, accentColor(key), 0.15);
    materials.set(key, { body, head, limbs, accent });
  }
}
function shade(hex: string, f: number): string {
  const c = BABYLON.Color3.FromHexString(hex);
  return c.scale(f).toHexString();
}
function accentColor(key: string): string {
  switch (key) {
    case "pig": return "#c47880";
    case "chicken": return "#e8a020";
    case "cow": return "#e8e0d0";
    case "spider": return "#ff3020";
    case "zombie": return "#2a5a2a";
    default: return "#d8d8d8";
  }
}

function box(parent: BABYLON.TransformNode, mat: BABYLON.Material, name: string,
             w: number, h: number, d: number, x: number, y: number, z: number): BABYLON.Mesh {
  const m = BABYLON.MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, scene);
  m.material = mat;
  m.position.set(x, y, z);
  m.parent = parent;
  return m;
}
// 头部盒子：六面分别采样 4x2 头贴图，只有 +Z 正面带五官
function headBox(parent: BABYLON.TransformNode, mat: BABYLON.Material, name: string,
                 w: number, h: number, d: number, x: number, y: number, z: number): BABYLON.Mesh {
  const m = new BABYLON.Mesh(name, scene);
  const g = buildBoxGeometry6({ top: 4, bottom: 5, front: 0, back: 1, left: 2, right: 3 }, 4, 2);
  const vd = new BABYLON.VertexData();
  vd.positions = g.positions;
  vd.normals = g.normals;
  vd.uvs = g.uvs;
  vd.indices = g.indices;
  vd.applyToMesh(m);
  m.material = mat;
  m.position.set(x, y, z);
  m.parent = parent;
  return m;
}
function leg(parent: BABYLON.TransformNode, mat: BABYLON.Material,
            w: number, h: number, d: number, x: number, yTop: number, z: number): BABYLON.TransformNode {
  const pivot = new BABYLON.TransformNode("legPivot", scene);
  pivot.position.set(x, yTop, z);
  pivot.parent = parent;
  box(pivot, mat, "leg", w, h, d, 0, -h / 2, 0);
  return pivot;
}
function buildBody(root: BABYLON.TransformNode, t: MobTypeDef, mats: TypeMaterials): BABYLON.TransformNode[] {
  const legs: BABYLON.TransformNode[] = [];
  switch (t.key) {
    case "pig": {
      box(root, mats.body, "body", 0.72, 0.5, 1.0, 0, 0.55, 0);
      headBox(root, mats.head, "head", 0.5, 0.46, 0.42, 0, 0.6, 0.55);
      box(root, mats.accent, "snout", 0.22, 0.16, 0.1, 0, 0.54, 0.78);
      for (const [x, z] of [[-0.24, 0.32], [0.24, 0.32], [-0.24, -0.32], [0.24, -0.32]])
        legs.push(leg(root, mats.limbs, 0.18, 0.3, 0.18, x, 0.3, z));
      break;
    }
    case "sheep": {
      box(root, mats.body, "body", 0.78, 0.62, 1.0, 0, 0.72, 0);
      headBox(root, mats.head, "head", 0.44, 0.44, 0.42, 0, 0.92, 0.52);
      for (const [x, z] of [[-0.24, 0.32], [0.24, 0.32], [-0.24, -0.32], [0.24, -0.32]])
        legs.push(leg(root, mats.limbs, 0.17, 0.42, 0.17, x, 0.42, z));
      break;
    }
    case "chicken": {
      box(root, mats.body, "body", 0.36, 0.36, 0.46, 0, 0.4, 0);
      headBox(root, mats.head, "head", 0.24, 0.24, 0.22, 0, 0.64, 0.2);
      box(root, mats.accent, "beak", 0.1, 0.08, 0.12, 0, 0.62, 0.35);
      box(root, mats.accent, "wattle", 0.06, 0.08, 0.06, 0, 0.54, 0.33);
      box(root, mats.limbs, "wingL", 0.06, 0.18, 0.3, -0.2, 0.42, 0);
      box(root, mats.limbs, "wingR", 0.06, 0.18, 0.3, 0.2, 0.42, 0);
      legs.push(leg(root, mats.accent, 0.07, 0.22, 0.07, -0.09, 0.22, 0));
      legs.push(leg(root, mats.accent, 0.07, 0.22, 0.07, 0.09, 0.22, 0));
      break;
    }
    case "cow": {
      box(root, mats.body, "body", 0.92, 0.7, 1.24, 0, 0.82, 0);
      headBox(root, mats.head, "head", 0.5, 0.46, 0.48, 0, 0.98, 0.72);
      box(root, mats.accent, "hornL", 0.1, 0.1, 0.1, -0.2, 1.2, 0.72);
      box(root, mats.accent, "hornR", 0.1, 0.1, 0.1, 0.2, 1.2, 0.72);
      box(root, mats.accent, "udder", 0.24, 0.12, 0.24, 0, 0.42, -0.2);
      for (const [x, z] of [[-0.3, 0.4], [0.3, 0.4], [-0.3, -0.4], [0.3, -0.4]])
        legs.push(leg(root, mats.limbs, 0.2, 0.48, 0.2, x, 0.48, z));
      break;
    }
    case "zombie": {
      box(root, mats.body, "torso", 0.5, 0.72, 0.3, 0, 1.14, 0);
      headBox(root, mats.head, "head", 0.46, 0.46, 0.46, 0, 1.74, 0);
      box(root, mats.limbs, "armL", 0.14, 0.16, 0.62, -0.32, 1.36, 0.28);
      box(root, mats.limbs, "armR", 0.14, 0.16, 0.62, 0.32, 1.36, 0.28);
      legs.push(leg(root, mats.limbs, 0.18, 0.78, 0.18, -0.13, 0.78, 0));
      legs.push(leg(root, mats.limbs, 0.18, 0.78, 0.18, 0.13, 0.78, 0));
      break;
    }
    case "spider": {
      box(root, mats.body, "abdomen", 0.72, 0.5, 0.78, 0, 0.5, -0.18);
      headBox(root, mats.head, "head", 0.44, 0.36, 0.4, 0, 0.44, 0.48);
      for (let i = 0; i < 4; i++) {
        const z = 0.28 - i * 0.2;
        legs.push(leg(root, mats.limbs, 0.06, 0.34, 0.06, -0.36, 0.46, z));
        legs.push(leg(root, mats.limbs, 0.06, 0.34, 0.06, 0.36, 0.46, z));
      }
      break;
    }
  }
  return legs;
}

function boxLines(w: number, h: number, d: number): BABYLON.LinesMesh {
  const x = w / 2, z = d / 2;
  const c = [
    [-x, 0, -z], [x, 0, -z], [x, 0, z], [-x, 0, z],
    [-x, h, -z], [x, h, -z], [x, h, z], [-x, h, z],
  ];
  const pairs = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  const points: BABYLON.Vector3[] = [];
  for (const [a, b] of pairs) {
    points.push(new BABYLON.Vector3(...c[a]));
    points.push(new BABYLON.Vector3(...c[b]));
  }
  const l = BABYLON.MeshBuilder.CreateLines("hb", { points }, scene);
  l.color = new BABYLON.Color3(1, 0.15, 0.1);
  l.isVisible = showHitboxes;
  l.parent = null;
  return l;
}

export function initMobs(sc: BABYLON.Scene): void {
  scene = sc;
  buildMaterials();
}

export function spawnMob(typeKey: string, x: number, z: number): Mob | null {
  const t = MOB_TYPES[typeKey];
  if (!t) return null;
  const bx = Math.floor(x), bz = Math.floor(z);
  const y = surfaceY(bx, bz);
  if (getBlock(bx, y, bz) === B.WATER) return null;   // 水下不刷生物（否则会沉在海底）

  const root = new BABYLON.TransformNode("mobRoot", scene);
  const mats = materials.get(typeKey)!;
  const legs = buildBody(root, t, mats);
  const hitbox = boxLines(t.w, t.h, t.w);
  const mob: Mob = {
    type: t, root, legs, hitbox,
    pos: new BABYLON.Vector3(x, y + 0.2, z),
    vel: new BABYLON.Vector3(0, 0, 0),
    yaw: Math.random() * Math.PI * 2,
    hp: t.hp, onGround: false,
    wanderTimer: Math.random() * 3, wanderDir: NaN,
    path: null, pathIdx: 0, repathTimer: 0, attackCd: 0,
    phase: Math.random() * Math.PI * 2, moving: false,
  };
  mobs.push(mob);
  return mob;
}

export function removeMobsOfType(typeKey: string): void {
  for (let i = mobs.length - 1; i >= 0; i--) if (mobs[i].type.key === typeKey) killMob(i);
}
export function clearMobs(): void {
  while (mobs.length) killMob(mobs.length - 1);
}
function killMob(i: number): void {
  const m = mobs[i];
  m.root.getChildMeshes().forEach(c => c.dispose());
  m.legs.forEach(l => l.dispose());
  m.root.dispose();
  m.hitbox.dispose();
  mobs.splice(i, 1);
}
export function countMobs(typeKey?: string): number {
  return typeKey ? mobs.filter(m => m.type.key === typeKey).length : mobs.length;
}
export function toggleHitboxes(): boolean {
  showHitboxes = !showHitboxes;
  for (const m of mobs) m.hitbox.isVisible = showHitboxes;
  return showHitboxes;
}

// ---------- 命中检测（精确 AABB） ----------
export function pickMobRay(origin: BABYLON.Vector3, dir: BABYLON.Vector3, maxDist: number):
  { mob: Mob; t: number } | null {
  let best: { mob: Mob; t: number } | null = null;
  for (const m of mobs) {
    const hw = m.type.w / 2;
    // 标量版 AABB：避免每帧为每只生物分配 Vector3
    const t = rayAABB(origin, dir,
      m.pos.x - hw, m.pos.y, m.pos.z - hw,
      m.pos.x + hw, m.pos.y + m.type.h, m.pos.z + hw);
    if (t !== null && t <= maxDist && (!best || t < best.t)) best = { mob: m, t };
  }
  return best;
}
function rayAABB(o: BABYLON.Vector3, d: BABYLON.Vector3,
                 minx: number, miny: number, minz: number,
                 maxx: number, maxy: number, maxz: number): number | null {
  let tmin = 0, tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    const oo = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const dd = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const mi = i === 0 ? minx : i === 1 ? miny : minz;
    const ma = i === 0 ? maxx : i === 1 ? maxy : maxz;
    if (Math.abs(dd) < 1e-8) {
      if (oo < mi || oo > ma) return null;
    } else {
      let t1 = (mi - oo) / dd, t2 = (ma - oo) / dd;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

export interface KillResult { coins: number; drops: Array<{ id: string; count: number }>; }
export function damageMob(mob: Mob, dmg: number, dir: BABYLON.Vector3): KillResult | null {
  mob.hp -= dmg;
  mob.vel.x += dir.x * 5; mob.vel.z += dir.z * 5; mob.vel.y += 3.5;
  if (mob.hp > 0) return null;
  const drops = mob.type.drops.map(d => ({
    id: d.id,
    count: d.min + Math.floor(Math.random() * (d.max - d.min + 1)),
  })).filter(d => d.count > 0);
  const coins = mob.type.coins;
  const i = mobs.indexOf(mob);
  if (i >= 0) killMob(i);
  return { coins, drops };
}

// ---------- A*（不允许上台阶：只能平走或下落） ----------
interface PCell { x: number; y: number; z: number; }
const man = (a: PCell, b: PCell): number =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z);

function findPath(s: PCell, t: PCell): PCell[] | null {
  const key = (c: PCell): string => `${c.x},${c.y},${c.z}`;
  const walkable = (x: number, y: number, z: number): boolean =>
    !isSolid(x, y, z) && !isSolid(x, y + 1, z) && isSolid(x, y - 1, z);
  const open: Array<{ c: PCell; g: number; f: number }> = [{ c: s, g: 0, f: man(s, t) }];
  const gs = new Map<string, number>([[key(s), 0]]);
  const came = new Map<string, string | null>([[key(s), null]]);
  let bestK = key(s), bestH = man(s, t);
  let iter = 0;
  while (open.length && iter < 500) {
    iter++;
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift()!;
    const h = man(cur.c, t);
    if (h < bestH) { bestH = h; bestK = key(cur.c); }
    if (h === 0) { bestK = key(cur.c); break; }
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (const dy of [0, -1, -2]) {   // 不能跳，只能下落
        const nx = cur.c.x + dx, ny = cur.c.y + dy, nz = cur.c.z + dz;
        if (!walkable(nx, ny, nz)) continue;
        const nk = `${nx},${ny},${nz}`;
        const ng = cur.g + 1 + (dy !== 0 ? 0.5 : 0);
        if ((gs.get(nk) ?? Infinity) <= ng) continue;
        gs.set(nk, ng);
        came.set(nk, key(cur.c));
        open.push({ c: { x: nx, y: ny, z: nz }, g: ng, f: ng + man({ x: nx, y: ny, z: nz }, t) });
        break;
      }
    }
  }
  const path: PCell[] = [];
  let k: string | null = bestK;
  while (k && k !== key(s)) {
    const [x, y, z] = k.split(",").map(Number);
    path.push({ x, y, z });
    k = came.get(k) ?? null;
  }
  path.reverse();
  return path;
}

// ---------- 物理与 AI ----------
function moveAxis(m: Mob, axis: "x" | "y" | "z", delta: number): boolean {
  if (delta === 0) return false;
  const old = m.pos[axis];
  m.pos[axis] += delta;
  if (boxCollides(m.pos.x, m.pos.y, m.pos.z, m.type.w / 2, m.type.h)) {
    m.pos[axis] = old;
    return true;
  }
  return false;
}

export function updateMobs(dt: number, playerPos: BABYLON.Vector3,
                           onPlayerDamage: (n: number) => void): void {
  for (let i = mobs.length - 1; i >= 0; i--) {
    const m = mobs[i];
    m.attackCd = Math.max(0, m.attackCd - dt);
    m.vel.y -= 26 * dt;
    if (m.vel.y < -40) m.vel.y = -40;

    let moveX = 0, moveZ = 0;
    const dist = Math.sqrt((m.pos.x - playerPos.x) ** 2 + (m.pos.z - playerPos.z) ** 2);

    if (m.type.hostile && dist < 20 && dist > 0.1) {
      m.repathTimer -= dt;
      if (m.repathTimer <= 0) {
        m.repathTimer = 1.0;
        m.path = findPath(
          { x: Math.floor(m.pos.x), y: Math.floor(m.pos.y), z: Math.floor(m.pos.z) },
          { x: Math.floor(playerPos.x), y: Math.floor(playerPos.y), z: Math.floor(playerPos.z) });
        m.pathIdx = 0;
      }
      const wp = m.path && m.pathIdx < m.path.length ? m.path[m.pathIdx] : null;
      if (wp && dist > 1.3) {
        const dx = wp.x + 0.5 - m.pos.x, dz = wp.z + 0.5 - m.pos.z;
        const dl = Math.sqrt(dx * dx + dz * dz);
        if (dl < 0.35) m.pathIdx++;
        else {
          moveX = (dx / dl) * m.type.speed;
          moveZ = (dz / dl) * m.type.speed;
          m.yaw = Math.atan2(dx, dz);
        }
      } else if (dist <= 1.3 && m.attackCd <= 0 && Math.abs(m.pos.y - playerPos.y) < 2) {
        onPlayerDamage(m.type.damage);
        m.attackCd = 1.6;
      }
    } else {
      m.wanderTimer -= dt;
      if (m.wanderTimer <= 0) {
        m.wanderTimer = 2 + Math.random() * 5;
        m.wanderDir = Math.random() < 0.3 ? NaN : Math.random() * Math.PI * 2;
      }
      if (!Number.isNaN(m.wanderDir)) {
        moveX = Math.sin(m.wanderDir) * m.type.speed * 0.55;
        moveZ = Math.cos(m.wanderDir) * m.type.speed * 0.55;
        m.yaw = m.wanderDir;
      }
    }

    m.vel.x = moveX; m.vel.z = moveZ;
    const vy = m.vel.y;
    if (moveAxis(m, "y", vy * dt)) {
      if (vy < 0) m.onGround = true;
      m.vel.y = 0;
    } else if (vy < 0) m.onGround = false;
    const bx = moveAxis(m, "x", m.vel.x * dt);
    const bz = moveAxis(m, "z", m.vel.z * dt);
    // 生物不会跳：撞墙就停下并换方向
    if (bx || bz) {
      if (m.type.hostile) m.path = null;
      else m.wanderTimer = 0;
    }

    if (m.pos.y < -5) { killMob(i); continue; }

    m.moving = Math.hypot(m.vel.x, m.vel.z) > 0.1;
    m.phase += dt * (m.moving ? 9 : 2);
    m.root.position.copyFrom(m.pos);
    m.root.rotation.y = m.yaw;
    // 腿部摆动
    const amp = m.moving ? 0.55 : 0.06;
    for (let li = 0; li < m.legs.length; li++) {
      m.legs[li].rotation.x = Math.sin(m.phase + (li % 2 === 0 ? 0 : Math.PI)) * amp;
    }
    m.hitbox.position.copyFrom(m.pos);
    m.hitbox.isVisible = showHitboxes;
  }
}

export function randomSurfacePos(near: BABYLON.Vector3, minD: number, maxD: number):
  { x: number; z: number } | null {
  for (let i = 0; i < 50; i++) {
    const a = Math.random() * Math.PI * 2;
    const d = minD + Math.random() * (maxD - minD);
    const x = Math.floor(near.x + Math.sin(a) * d);
    const z = Math.floor(near.z + Math.cos(a) * d);
    if (x < 2 || z < 2 || x >= SX - 2 || z >= SZ - 2) continue;
    return { x: x + 0.5, z: z + 0.5 };
  }
  return null;
}
