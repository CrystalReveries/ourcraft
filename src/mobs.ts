/* 生物系统：多部件模型 + 程序化贴图 + 行走动画 + A* 寻路
 * 规则：生物不能跳跃（寻路只允许平走与下落），伤害数值较低。
 */
import * as BABYLON from "@babylonjs/core";
import { SX, SZ } from "./config";
import { boxCollides, surfaceY, isSolid } from "./world";

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

function faceTexture(type: MobTypeDef): BABYLON.DynamicTexture {
  const tex = new BABYLON.DynamicTexture("face_" + type.key, { width: 64, height: 64 }, scene, true);
  tex.hasAlpha = false;
  const c = tex.getContext() as CanvasRenderingContext2D;
  c.fillStyle = type.color;
  c.fillRect(0, 0, 64, 64);
  // 眼睛
  c.fillStyle = type.hostile ? "#ff3020" : "#1a1a1a";
  const eyeY = type.key === "spider" ? 22 : 26;
  c.fillRect(14, eyeY, 10, 8);
  c.fillRect(40, eyeY, 10, 8);
  // 高光
  c.fillStyle = "#ffffff";
  c.fillRect(16, eyeY + 1, 3, 3);
  c.fillRect(42, eyeY + 1, 3, 3);
  // 嘴/鼻子
  if (type.key === "pig") {
    c.fillStyle = "#c47880";
    c.fillRect(22, 42, 20, 12);
    c.fillStyle = "#8a4a52";
    c.fillRect(26, 46, 4, 5);
    c.fillRect(34, 46, 4, 5);
  } else if (type.key === "chicken") {
    c.fillStyle = "#e8a020";
    c.fillRect(26, 44, 12, 8);
  } else if (type.key === "zombie") {
    c.fillStyle = "#2a5a2a";
    c.fillRect(20, 46, 24, 6);
    c.fillStyle = "#cfcfcf";
    for (let i = 0; i < 4; i++) c.fillRect(22 + i * 6, 46, 3, 4);
  } else {
    c.fillStyle = "rgba(0,0,0,0.32)";
    c.fillRect(24, 46, 16, 4);
  }
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
    head.diffuseTexture = faceTexture(t);
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
      box(root, mats.head, "head", 0.5, 0.46, 0.42, 0, 0.6, 0.55);
      box(root, mats.accent, "snout", 0.22, 0.16, 0.1, 0, 0.54, 0.78);
      for (const [x, z] of [[-0.24, 0.32], [0.24, 0.32], [-0.24, -0.32], [0.24, -0.32]])
        legs.push(leg(root, mats.limbs, 0.18, 0.3, 0.18, x, 0.3, z));
      break;
    }
    case "sheep": {
      box(root, mats.body, "body", 0.78, 0.62, 1.0, 0, 0.72, 0);
      box(root, mats.head, "head", 0.44, 0.44, 0.42, 0, 0.92, 0.52);
      for (const [x, z] of [[-0.24, 0.32], [0.24, 0.32], [-0.24, -0.32], [0.24, -0.32]])
        legs.push(leg(root, mats.limbs, 0.17, 0.42, 0.17, x, 0.42, z));
      break;
    }
    case "chicken": {
      box(root, mats.body, "body", 0.36, 0.36, 0.46, 0, 0.4, 0);
      box(root, mats.head, "head", 0.24, 0.24, 0.22, 0, 0.64, 0.2);
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
      box(root, mats.head, "head", 0.5, 0.46, 0.48, 0, 0.98, 0.72);
      box(root, mats.accent, "hornL", 0.1, 0.1, 0.1, -0.2, 1.2, 0.72);
      box(root, mats.accent, "hornR", 0.1, 0.1, 0.1, 0.2, 1.2, 0.72);
      box(root, mats.accent, "udder", 0.24, 0.12, 0.24, 0, 0.42, -0.2);
      for (const [x, z] of [[-0.3, 0.4], [0.3, 0.4], [-0.3, -0.4], [0.3, -0.4]])
        legs.push(leg(root, mats.limbs, 0.2, 0.48, 0.2, x, 0.48, z));
      break;
    }
    case "zombie": {
      box(root, mats.body, "torso", 0.5, 0.72, 0.3, 0, 1.14, 0);
      box(root, mats.head, "head", 0.46, 0.46, 0.46, 0, 1.74, 0);
      box(root, mats.limbs, "armL", 0.14, 0.16, 0.62, -0.32, 1.36, 0.28);
      box(root, mats.limbs, "armR", 0.14, 0.16, 0.62, 0.32, 1.36, 0.28);
      legs.push(leg(root, mats.limbs, 0.18, 0.78, 0.18, -0.13, 0.78, 0));
      legs.push(leg(root, mats.limbs, 0.18, 0.78, 0.18, 0.13, 0.78, 0));
      break;
    }
    case "spider": {
      box(root, mats.body, "abdomen", 0.72, 0.5, 0.78, 0, 0.5, -0.18);
      box(root, mats.head, "head", 0.44, 0.36, 0.4, 0, 0.44, 0.48);
      box(root, mats.accent, "eyeL", 0.08, 0.08, 0.04, -0.1, 0.54, 0.68);
      box(root, mats.accent, "eyeR", 0.08, 0.08, 0.04, 0.1, 0.54, 0.68);
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
  const y = surfaceY(Math.floor(x), Math.floor(z));
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
    const min = new BABYLON.Vector3(m.pos.x - hw, m.pos.y, m.pos.z - hw);
    const max = new BABYLON.Vector3(m.pos.x + hw, m.pos.y + m.type.h, m.pos.z + hw);
    const t = rayAABB(origin, dir, min, max);
    if (t !== null && t <= maxDist && (!best || t < best.t)) best = { mob: m, t };
  }
  return best;
}
function rayAABB(o: BABYLON.Vector3, d: BABYLON.Vector3,
                 min: BABYLON.Vector3, max: BABYLON.Vector3): number | null {
  let tmin = 0, tmax = Infinity;
  const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
  const mi = [min.x, min.y, min.z], ma = [max.x, max.y, max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(dd[i]) < 1e-8) {
      if (oo[i] < mi[i] || oo[i] > ma[i]) return null;
    } else {
      let t1 = (mi[i] - oo[i]) / dd[i], t2 = (ma[i] - oo[i]) / dd[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
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
