/* 主模块：玩家、输入、背包/合成/饥饿、挖掘与战斗、HUD、面板、命令、LAN 联机 */
import * as BABYLON from "@babylonjs/core";
import {
  SX, SZ, REACH, ATTACK_REACH, GRAVITY, JUMP_V, B, DEFS, SEA_LEVEL,
} from "./config";
import {
  Inventory, RECIPES, craft, canCraft, ITEMS, itemName, itemColor, blockItem,
  bestTool, bestSwordDamage, toolLabel,
} from "./items";
import {
  initWorld, generateWorld, buildAllInstances, getBlock, boxCollides,
  breakBlock, placeBlock, raycastBlock, toggleLeverAt, setBlockRemote, surfaceY, leverOn,
  villageSites, setWaterMode, getWaterMode, WaterMode,
} from "./world";
import {
  initMobs, spawnMob, updateMobs, pickMobRay, damageMob, removeMobsOfType,
  clearMobs, countMobs, toggleHitboxes, MOB_TYPES, randomSurfacePos,
} from "./mobs";
import { Environment } from "./systems";
import { NetClient } from "./net";

// ---------- 引擎 ----------
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new BABYLON.Engine(canvas, true, {
  stencil: false,
  antialias: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
  doNotHandleContextLost: true,
});
const scene = new BABYLON.Scene(engine);
scene.skipPointerMovePicking = true;
scene.blockMaterialDirtyMechanism = true;

const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.1), scene);
hemi.intensity = 0.85;
// 给朝下的面（树冠底、屋檐、洞穴顶）一点环境光，否则纯黑
hemi.groundColor = new BABYLON.Color3(0.42, 0.45, 0.5);
const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, 0.4), scene);
sun.intensity = 0.65;
scene.fogMode = BABYLON.Scene.FOGMODE_LINEAR;
scene.fogStart = 70;
scene.fogEnd = 190;
scene.clearColor = new BABYLON.Color4(0.53, 0.81, 0.92, 1);

const camera = new BABYLON.FreeCamera("cam", new BABYLON.Vector3(SX / 2, 50, SZ / 2), scene);
camera.minZ = 0.1;
camera.fov = 1.1;
scene.activeCamera = camera;

// ---------- 世界 ----------
initWorld(scene);
generateWorld();
buildAllInstances();
const env = new Environment(scene, sun, hemi);
initMobs(scene);

// ---------- 玩家模型（第三人称可见） ----------
function buildPlayerAvatar(): BABYLON.TransformNode {
  const root = new BABYLON.TransformNode("playerAvatar", scene);
  const skin = new BABYLON.StandardMaterial("avatarSkin", scene);
  skin.diffuseColor = BABYLON.Color3.FromHexString("#e0b48a");
  skin.specularColor = BABYLON.Color3.Black();
  const shirt = new BABYLON.StandardMaterial("avatarShirt", scene);
  shirt.diffuseColor = BABYLON.Color3.FromHexString("#3f6fb0");
  shirt.specularColor = BABYLON.Color3.Black();
  const pants = new BABYLON.StandardMaterial("avatarPants", scene);
  pants.diffuseColor = BABYLON.Color3.FromHexString("#33465f");
  pants.specularColor = BABYLON.Color3.Black();
  const part = (mat: BABYLON.Material, w: number, h: number, d: number, x: number, y: number, z: number): void => {
    const m = BABYLON.MeshBuilder.CreateBox("av", { width: w, height: h, depth: d }, scene);
    m.material = mat;
    m.position.set(x, y, z);
    m.parent = root;
  };
  part(shirt, 0.5, 0.72, 0.3, 0, 1.14, 0);      // 躯干
  part(skin, 0.46, 0.46, 0.46, 0, 1.72, 0);     // 头
  part(shirt, 0.14, 0.56, 0.18, -0.32, 1.2, 0); // 左臂
  part(shirt, 0.14, 0.56, 0.18, 0.32, 1.2, 0);  // 右臂
  part(pants, 0.18, 0.72, 0.18, -0.13, 0.42, 0);// 左腿
  part(pants, 0.18, 0.72, 0.18, 0.13, 0.42, 0); // 右腿
  root.setEnabled(false);
  return root;
}
const playerAvatar = buildPlayerAvatar();

// ---------- 背包 ----------
const inv = new Inventory();
inv.add(blockItem(B.PLANKS), 16);
inv.add("mat:stick", 10);
inv.add("tool:pick:wood", 1);

// ---------- 玩家 ----------
interface Player {
  pos: BABYLON.Vector3;
  vel: BABYLON.Vector3;
  yaw: number; pitch: number;
  onGround: boolean; fly: boolean;
  hw: number; height: number; eye: number;
  hp: number; hunger: number; coins: number;
}
const player: Player = {
  pos: new BABYLON.Vector3(SX / 2 + 0.5, 0, SZ / 2 + 0.5),
  vel: new BABYLON.Vector3(0, 0, 0),
  yaw: 0, pitch: 0,
  onGround: false, fly: false,
  hw: 0.3, height: 1.8, eye: 1.62,
  hp: 20, hunger: 20, coins: 0,
};

let spawnPoint = new BABYLON.Vector3();
function respawn(): void {
  const cx = SX >> 1, cz = SZ >> 1;
  let sx = cx, sz = cz, sy = surfaceY(cx, cz);
  // 从中心螺旋向外找一块"高于海平面且脚下不是水"的陆地出生
  search: for (let r = 0; r < 48; r++) {
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        if (Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
        const x = cx + dx, z = cz + dz;
        if (x < 3 || z < 3 || x >= SX - 3 || z >= SZ - 3) continue;
        const y = surfaceY(x, z);
        if (y > SEA_LEVEL && getBlock(x, y, z) !== B.WATER) { sx = x; sz = z; sy = y; break search; }
      }
  }
  spawnPoint = new BABYLON.Vector3(sx + 0.5, sy + 0.05, sz + 0.5);
}
function placePlayerAtSpawn(): void {
  player.pos.copyFrom(spawnPoint);
  player.vel.setAll(0);
  player.hp = 20;
  player.hunger = 20;
}
respawn();
placePlayerAtSpawn();

// ---------- 环境引用 ----------
const overlay = document.getElementById("overlay") as HTMLDivElement;
const fpsEl = document.getElementById("fps") as HTMLDivElement;
const heartsEl = document.getElementById("hearts") as HTMLDivElement;
const hungerEl = document.getElementById("hunger") as HTMLDivElement;
const coinsEl = document.getElementById("coins") as HTMLDivElement;
const toolsEl = document.getElementById("tools") as HTMLDivElement;
const hotbarEl = document.getElementById("hotbar") as HTMLDivElement;
const mineBar = document.getElementById("mineBar") as HTMLDivElement;
const mineFill = document.getElementById("mineFill") as HTMLDivElement;
const msgsEl = document.getElementById("msgs") as HTMLDivElement;
const panel = document.getElementById("panel") as HTMLDivElement;
const consoleWrap = document.getElementById("consoleWrap") as HTMLDivElement;
const consoleInput = document.getElementById("consoleInput") as HTMLInputElement;
const invPanel = document.getElementById("invPanel") as HTMLDivElement;
const invGrid = document.getElementById("invGrid") as HTMLDivElement;
const craftListEl = document.getElementById("craftList") as HTMLDivElement;
const chatLogEl = document.getElementById("chatLog") as HTMLDivElement;
const chatInput = document.getElementById("chatInput") as HTMLInputElement;
const chatWrap = document.getElementById("chatWrap") as HTMLDivElement;
const connectWrap = document.getElementById("connectWrap") as HTMLDivElement;
const nameInput = document.getElementById("nameInput") as HTMLInputElement;
const serverInput = document.getElementById("serverInput") as HTMLInputElement;
const netStatusEl = document.getElementById("netStatus") as HTMLDivElement;
const playerCountEl = document.getElementById("playerCount") as HTMLDivElement;
const tutorialEl = document.getElementById("tutorial") as HTMLDivElement;
const tutDontShow = document.getElementById("tutDontShow") as HTMLInputElement;
const tutCloseBtn = document.getElementById("tutClose") as HTMLButtonElement;

let dead = false;
let locked = false;
let panelOpen = false;
let consoleOpen = false;
let invOpen = false;
let chatOpen = false;
let connectOpen = false;
let tutorialOpen = false;
let thirdPerson = false;
const uiOpen = (): boolean => panelOpen || consoleOpen || invOpen || chatOpen || connectOpen || tutorialOpen;

function msg(text: string): void {
  const d = document.createElement("div");
  d.textContent = text;
  msgsEl.appendChild(d);
  setTimeout(() => d.remove(), 6000);
  while (msgsEl.children.length > 6) msgsEl.firstChild?.remove();
}
function addChat(from: string, text: string): void {
  const d = document.createElement("div");
  d.textContent = `${from}: ${text}`;
  chatLogEl.appendChild(d);
  while (chatLogEl.children.length > 8) chatLogEl.firstChild?.remove();
  setTimeout(() => d.remove(), 20000);
}

// ---------- HUD ----------
for (let i = 0; i < 10; i++) {
  const s = document.createElement("span");
  s.textContent = "♥";
  heartsEl.appendChild(s);
  const h = document.createElement("span");
  h.textContent = "🍗";
  hungerEl.appendChild(h);
}
function refreshHUD(): void {
  for (let i = 0; i < 10; i++) {
    const hp = player.hp - i * 2;
    (heartsEl.children[i] as HTMLElement).style.color = hp >= 2 ? "#ff4444" : hp >= 1 ? "#ff8888" : "#3a1515";
    const hg = player.hunger - i * 2;
    (hungerEl.children[i] as HTMLElement).style.opacity = hg >= 2 ? "1" : hg >= 1 ? "0.5" : "0.18";
  }
  coinsEl.textContent = `💰 ${player.coins}`;
  toolsEl.textContent =
    `${toolLabel(inv, "pick")} · ${toolLabel(inv, "axe")} · ${toolLabel(inv, "shovel")} · 剑伤害 ${bestSwordDamage(inv)}`;
  renderHotbar();
}
// ---------- 物品图标（程序化纹理，带明暗/噪点） ----------
const _iconCache = new Map<string, string>();
function shadeHex(hex: string, f: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
  const b = Math.min(255, Math.round((n & 255) * f));
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
function poly(x: CanvasRenderingContext2D, pts: number[][]): void {
  x.beginPath();
  x.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) x.lineTo(pts[i][0], pts[i][1]);
  x.closePath();
  x.fill();
}
function tierHex(tier: string): string {
  switch (tier) {
    case "wood": return "#a3814f";
    case "stone": return "#8a8a8a";
    case "iron": return "#d8d8d8";
    case "gold": return "#f0cf4a";
    case "diamond": return "#4ee0e0";
    default: return "#cccccc";
  }
}
function itemIcon(id: string): string {
  const cached = _iconCache.get(id);
  if (cached) return cached;
  const d = ITEMS[id];
  const cv = document.createElement("canvas");
  cv.width = 48; cv.height = 48;
  const x = cv.getContext("2d")!;
  x.clearRect(0, 0, 48, 48);
  if (d && d.kind === "block" && d.blockId !== undefined) {
    const col = DEFS[d.blockId].color;
    x.fillStyle = shadeHex(col, 1.22); poly(x, [[24, 9], [40, 17], [24, 25], [8, 17]]);
    x.fillStyle = col;                  poly(x, [[8, 17], [24, 25], [24, 41], [8, 33]]);
    x.fillStyle = shadeHex(col, 0.7);   poly(x, [[40, 17], [24, 25], [24, 41], [40, 33]]);
    x.strokeStyle = "rgba(0,0,0,0.22)"; x.lineWidth = 1;
    x.beginPath(); x.moveTo(24, 9); x.lineTo(24, 41); x.moveTo(8, 17); x.lineTo(40, 17); x.stroke();
    for (let i = 0; i < 26; i++) {
      x.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.08})`;
      x.fillRect(9 + Math.random() * 30, 18 + Math.random() * 22, 2, 2);
    }
  } else if (d && d.kind === "tool") {
    const tier = d.tool ? tierHex(d.tool.tier) : "#a3814f";
    x.strokeStyle = "#8a6a3c"; x.lineWidth = 5; x.lineCap = "round";
    x.beginPath(); x.moveTo(14, 40); x.lineTo(30, 16); x.stroke();
    x.fillStyle = tier;
    if (d.tool?.type === "sword") poly(x, [[26, 6], [34, 14], [22, 26], [18, 22]]);
    else if (d.tool?.type === "pick") poly(x, [[12, 18], [18, 10], [34, 14], [30, 18], [20, 16]]);
    else if (d.tool?.type === "axe") poly(x, [[22, 8], [34, 12], [34, 22], [24, 18]]);
    else poly(x, [[24, 8], [34, 16], [30, 24], [22, 22]]);
  } else if (d && d.kind === "food") {
    x.fillStyle = d.color;
    x.beginPath(); x.ellipse(24, 27, 15, 12, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = shadeHex(d.color, 0.72);
    x.beginPath(); x.ellipse(24, 31, 9, 5, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = "rgba(255,255,255,0.35)";
    x.beginPath(); x.ellipse(19, 22, 4, 3, -0.4, 0, Math.PI * 2); x.fill();
  } else {
    const col = d?.color ?? "#999999";
    if (id.includes("diamond") || id.includes("emerald")) {
      x.fillStyle = col; poly(x, [[24, 8], [38, 20], [24, 40], [10, 20]]);
      x.fillStyle = "rgba(255,255,255,0.5)"; poly(x, [[24, 12], [30, 20], [24, 24], [18, 20]]);
    } else {
      x.fillStyle = shadeHex(col, 0.7); x.fillRect(10, 22, 28, 12);
      x.fillStyle = col; x.fillRect(12, 20, 24, 9);
      x.fillStyle = "rgba(255,255,255,0.4)"; x.fillRect(15, 22, 18, 2);
    }
  }
  const url = cv.toDataURL();
  _iconCache.set(id, url);
  return url;
}

function renderHotbar(): void {
  hotbarEl.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    const slot = inv.slots[i];
    const d = document.createElement("div");
    d.className = "slot" + (i === inv.selected ? " active" : "");
    const num = document.createElement("span");
    num.className = "slotNum";
    num.textContent = String(i + 1);
    d.appendChild(num);
    if (slot) {
      d.style.backgroundImage = `url("${itemIcon(slot.id)}")`;
      d.title = itemName(slot.id);
      if (slot.count > 1) {
        const c = document.createElement("span");
        c.className = "cnt";
        c.textContent = String(slot.count);
        d.appendChild(c);
      }
    }
    d.addEventListener("click", () => { inv.selected = i; renderHotbar(); });
    hotbarEl.appendChild(d);
  }
}
function renderInventory(): void {
  invGrid.innerHTML = "";
  for (let i = 0; i < 36; i++) {
    const slot = inv.slots[i];
    const d = document.createElement("div");
    d.className = "invSlot" + (i === inv.selected ? " active" : "") + (i < 9 ? " hot" : "");
    if (slot) {
      d.style.borderColor = itemColor(slot.id);
      d.style.backgroundImage = `url("${itemIcon(slot.id)}")`;
      d.style.backgroundSize = "72%";
      d.style.backgroundPosition = "center";
      d.style.backgroundRepeat = "no-repeat";
      d.title = itemName(slot.id);
      if (slot.count > 1) {
        const c = document.createElement("span");
        c.className = "cnt";
        c.textContent = "×" + slot.count;
        d.appendChild(c);
      }
    } else {
      d.textContent = i < 9 ? `${i + 1}` : "";
    }
    d.addEventListener("click", () => {
      if (i < 9) inv.selected = i;
      else {
        const sel = inv.slots[inv.selected];
        inv.slots[i] = sel;
        inv.slots[inv.selected] = slot;
      }
      renderInventory(); renderHotbar(); renderCrafting();
    });
    invGrid.appendChild(d);
  }
  document.getElementById("invHint")!.textContent =
    `当前选中: ${inv.selectedSlot() ? itemName(inv.selectedSlot()!.id) : "空"}`;
}
function renderCrafting(): void {
  craftListEl.innerHTML = "";
  for (const r of RECIPES) {
    const row = document.createElement("div");
    row.className = "craftRow";
    const ok = canCraft(inv, r);
    const b = document.createElement("button");
    b.className = "pbtn";
    b.textContent = `${itemName(r.out)}${r.count > 1 ? " ×" + r.count : ""}`;
    b.disabled = !ok;
    b.addEventListener("click", () => {
      if (craft(inv, r)) {
        msg(`制作了 ${itemName(r.out)} ×${r.count}`);
        renderInventory(); renderHotbar(); refreshHUD(); renderCrafting();
      }
    });
    const need = r.need.map(n => `${itemName(n.id)}×${n.count}`).join(" + ");
    const info = document.createElement("span");
    info.className = "craftInfo";
    info.textContent = need;
    row.appendChild(b);
    row.appendChild(info);
    craftListEl.appendChild(row);
  }
}

// ---------- 指针锁定与面板 ----------
function lock(): void { if (!dead) canvas.requestPointerLock(); }
overlay.addEventListener("click", () => {
  if (dead) { dead = false; placePlayerAtSpawn(); overlay.textContent = "点击屏幕开始游戏"; }
  lock();
});
canvas.addEventListener("click", () => { if (!locked && !uiOpen()) lock(); });
document.addEventListener("pointerlockchange", () => {
  locked = document.pointerLockElement === canvas;
  overlay.style.display = locked || uiOpen() ? "none" : "flex";
  if (!locked) { for (const k of Object.keys(keys)) keys[k] = false; mouseLeft = false; }
});
function openPanel(): void {
  panelOpen = true; panel.style.display = "block";
  renderShopInfo(); renderBanList(); refreshHUD();
  document.exitPointerLock(); overlay.style.display = "none";
}
function closePanel(): void { panelOpen = false; panel.style.display = "none"; lock(); }
function openConsole(): void {
  consoleOpen = true; consoleWrap.style.display = "flex";
  document.exitPointerLock(); overlay.style.display = "none";
  setTimeout(() => consoleInput.focus(), 50);
}
function closeConsole(): void { consoleOpen = false; consoleInput.value = ""; consoleWrap.style.display = "none"; lock(); }
function openInventory(): void {
  invOpen = true; invPanel.style.display = "block";
  renderInventory(); renderCrafting(); renderHotbar();
  document.exitPointerLock(); overlay.style.display = "none";
}
function closeInventory(): void { invOpen = false; invPanel.style.display = "none"; lock(); }
function openChat(): void {
  chatOpen = true; chatWrap.style.display = "flex";
  document.exitPointerLock(); overlay.style.display = "none";
  setTimeout(() => chatInput.focus(), 50);
}
function closeChat(): void { chatOpen = false; chatInput.value = ""; chatWrap.style.display = "none"; lock(); }
function openConnect(): void {
  connectOpen = true; connectWrap.style.display = "flex";
  if (!nameInput.value) nameInput.value = "玩家" + Math.floor(Math.random() * 900 + 100);
  document.exitPointerLock(); overlay.style.display = "none";
}
function closeConnect(): void { connectOpen = false; connectWrap.style.display = "none"; lock(); }
function openTutorial(): void {
  tutorialOpen = true;
  tutorialEl.style.display = "flex";
  document.exitPointerLock();
  overlay.style.display = "none";
}
function closeTutorial(): void {
  tutorialOpen = false;
  tutorialEl.style.display = "none";
  if (tutDontShow.checked) localStorage.setItem("mc_tut", "1");
  if (dead) overlay.style.display = "flex";
  else if (!uiOpen()) lock();
}

// ---------- 输入 ----------
const keys: Record<string, boolean> = {};
let mouseLeft = false;
let miningKey: string | null = null;
let miningProgress = 0;
let eatCd = 0;

document.addEventListener("mousemove", (e: MouseEvent) => {
  if (!locked) return;
  player.yaw += e.movementX * 0.0026;
  player.pitch += e.movementY * 0.0026;
  player.pitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, player.pitch));
});
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (tutorialOpen) { if (e.code === "Escape" || e.code === "KeyH") closeTutorial(); return; }
  if (chatOpen) { if (e.code === "Escape") closeChat(); return; }
  if (consoleOpen) { if (e.code === "Escape") closeConsole(); return; }
  if (connectOpen) { if (e.code === "Escape") closeConnect(); return; }
  if (invOpen) { if (e.code === "KeyE" || e.code === "Escape") closeInventory(); return; }
  if (panelOpen) { if (e.code === "KeyP" || e.code === "Escape") closePanel(); return; }

  keys[e.code] = true;
  if (e.code === "KeyF") player.fly = !player.fly;
  if (e.code === "F3") { e.preventDefault(); msg(`碰撞箱: ${toggleHitboxes() ? "开" : "关"}`); }
  if (e.code === "KeyE") { e.preventDefault(); openInventory(); }
  if (e.code === "KeyP") openPanel();
  if (e.code === "KeyH") { e.preventDefault(); openTutorial(); return; }
  if (e.code === "KeyV") { thirdPerson = !thirdPerson; msg(thirdPerson ? "第三人称视角" : "第一人称视角"); }
  if (e.code === "KeyT") { e.preventDefault(); openConsole(); }
  if (e.code === "KeyY") { e.preventDefault(); openChat(); }
  if (e.code.startsWith("Digit")) {
    const n = Number(e.code.slice(5)) - 1;
    if (n >= 0 && n < 9) { inv.selected = n; renderHotbar(); }
  }
});
document.addEventListener("keyup", (e: KeyboardEvent) => { keys[e.code] = false; });
document.addEventListener("wheel", (e: WheelEvent) => {
  if (!locked) return;
  inv.selected = (inv.selected + (e.deltaY > 0 ? 1 : -1) + 9) % 9;
  renderHotbar();
});
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ---------- 工具与交互 ----------
function miningSpeedFor(blockId: number): number {
  const def = DEFS[blockId];
  if (!def) return 1;
  if (!def.tool) return 1;
  const t = bestTool(inv, def.tool);
  return t ? t.speed : 1;
}
function tryEat(): boolean {
  const slot = inv.selectedSlot();
  if (!slot) return false;
  const d = ITEMS[slot.id];
  if (!d || d.kind !== "food" || !d.food) return false;
  if (player.hunger >= 20) { msg("并不饿"); return false; }
  inv.remove(slot.id, 1);
  player.hunger = Math.min(20, player.hunger + d.food);
  msg(`吃了 ${d.name} (+${d.food} 饥饿值)`);
  refreshHUD();
  return true;
}
function placeSelected(hit: { px: number; py: number; pz: number }): void {
  const slot = inv.selectedSlot();
  if (!slot) { msg("背包中没有方块"); return; }
  const d = ITEMS[slot.id];
  if (!d || d.kind !== "block" || d.blockId === undefined) { msg("手上的物品不能放置"); return; }
  const { px, py, pz } = hit;
  const hw = player.hw;
  const intersects =
    px + 1 > player.pos.x - hw && px < player.pos.x + hw &&
    pz + 1 > player.pos.z - hw && pz < player.pos.z + hw &&
    py + 1 > player.pos.y && py < player.pos.y + player.height;
  if (intersects) { msg("不能放在自己身上"); return; }
  const r = placeBlock(px, py, pz, d.blockId);
  if (!r.ok) { msg(r.msg); return; }
  inv.remove(slot.id, 1);
  if (net.connected) net.sendBlock(px, py, pz, d.blockId);
  renderHotbar(); refreshHUD();
}

document.addEventListener("mousedown", (e: MouseEvent) => {
  if (!locked) return;
  const camPos = camera.globalPosition;
  const camDir = camera.getDirection(BABYLON.Axis.Z).normalize();

  if (e.button === 0) {
    const mobHit = pickMobRay(camPos, camDir, ATTACK_REACH);
    const bHit = raycastBlock(camPos, camDir, REACH);
    const bDist = bHit ? bHit.dist : Infinity;
    if (mobHit && mobHit.t < bDist) {
      const res = damageMob(mobHit.mob, bestSwordDamage(inv), camDir);
      if (res) {
        player.coins += res.coins;
        for (const d of res.drops) inv.add(d.id, d.count);
        msg(`击杀 ${mobHit.mob.type.name} +${res.coins}💰`);
        refreshHUD();
      }
    } else {
      mouseLeft = true; miningKey = null; miningProgress = 0;
    }
  } else if (e.button === 2) {
    const hit = raycastBlock(camPos, camDir, REACH);
    if (!hit) return;
    if (getBlock(hit.x, hit.y, hit.z) === B.LEVER) {
      toggleLeverAt(hit.x, hit.y, hit.z);
      const on = leverOn.has(`${hit.x},${hit.y},${hit.z}`);
      msg(`拉杆: ${on ? "开" : "关"}`);
      if (net.connected) net.sendBlock(hit.x, hit.y, hit.z, B.LEVER);
      return;
    }
    if (tryEat()) return;
    placeSelected({ px: hit.px, py: hit.py, pz: hit.pz });
  }
});
document.addEventListener("mouseup", (e: MouseEvent) => {
  if (e.button === 0) { mouseLeft = false; miningProgress = 0; mineBar.style.display = "none"; }
});

// ---------- 战斗/伤害 ----------
let regenTimer = 0;
function damagePlayer(n: number): void {
  if (dead) return;
  player.hp -= n;
  regenTimer = 8;
  refreshHUD();
  if (player.hp <= 0) {
    dead = true; player.hp = 0;
    document.exitPointerLock();
    overlay.style.display = "flex";
    overlay.textContent = "你死了！点击重生";
  }
}

// ---------- 联机 ----------
const net = new NetClient(scene, {
  onBlock: (x, y, z, id) => setBlockRemote(x, y, z, id),
  onStatus: (text, connected) => {
    netStatusEl.textContent = text;
    netStatusEl.style.color = connected ? "#7f7" : "#f88";
  },
  onChat: (from, text) => addChat(from, text),
  onPlayers: (names) => { playerCountEl.textContent = `${names.length} 人在线`; },
});
(document.getElementById("connectBtn") as HTMLButtonElement).addEventListener("click", async () => {
  const name = nameInput.value.trim() || "玩家";
  const url = serverInput.value.trim() || `ws://${location.hostname}:8787`;
  netStatusEl.textContent = "连接中…";
  try {
    await net.connect(url, name, player.pos, player.yaw);
    closeConnect();
    addChat("系统", `已连接 ${url}`);
  } catch (err) {
    netStatusEl.textContent = `连接失败: ${(err as Error).message}`;
  }
});
(document.getElementById("disconnectBtn") as HTMLButtonElement).addEventListener("click", () => {
  net.disconnect();
  netStatusEl.textContent = "未连接";
  playerCountEl.textContent = "0 人在线";
  addChat("系统", "已断开连接");
});

// ---------- 命令 ----------
const banned = new Set<string>(JSON.parse(localStorage.getItem("mc_banned") ?? "[]") as string[]);
function execCommand(raw: string): void {
  const line = raw.trim();
  if (!line) return;
  if (!line.startsWith("/")) { if (net.connected) net.sendChat(line); else addChat("你", line); return; }
  const [cmd, ...args] = line.slice(1).split(/\s+/);
  switch (cmd) {
    case "help":
      msg("/time day|noon|night · /weather clear|rain · /tp x y z");
      msg("/give n · /blocks · /ban|unban <pig|sheep|chicken|cow|zombie|spider> · /clearmobs");
      break;
    case "time":
      if (args[0] === "day") { env.setTime(0.1); msg("时间 → 白天"); }
      else if (args[0] === "noon") { env.setTime(0.25); msg("时间 → 正午"); }
      else if (args[0] === "night") { env.setTime(0.7); msg("时间 → 夜晚"); }
      else msg("用法: /time day|noon|night");
      break;
    case "weather":
      if (args[0] === "clear" || args[0] === "rain") { env.setWeather(args[0]); msg(`天气 → ${args[0]}`); }
      else msg("用法: /weather clear|rain");
      break;
    case "tp": {
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some(v => Number.isNaN(v))) { msg("用法: /tp x y z"); break; }
      player.pos.set(x, y, z); player.vel.setAll(0);
      msg(`已传送到 ${x},${y},${z}`);
      break;
    }
    case "ban": case "unban": {
      const t = args[0];
      if (!MOB_TYPES[t]) { msg("用法: /ban <pig|sheep|chicken|cow|zombie|spider>"); break; }
      if (cmd === "ban") { banned.add(t); removeMobsOfType(t); msg(`已封禁 ${MOB_TYPES[t].name}`); }
      else { banned.delete(t); msg(`已解封 ${MOB_TYPES[t].name}`); }
      localStorage.setItem("mc_banned", JSON.stringify([...banned]));
      break;
    }
    case "banlist":
      msg(banned.size ? `封禁列表: ${[...banned].join(", ")}` : "封禁列表为空");
      break;
    case "give": {
      const n = Number(args[0]);
      if (Number.isNaN(n)) { msg("用法: /give n"); break; }
      player.coins += n; refreshHUD(); msg(`+${n} 金币`);
      break;
    }
    case "blocks":
      inv.add(blockItem(B.PLANKS), 64);
      inv.add(blockItem(B.COBBLE), 64);
      inv.add(blockItem(B.STONE), 64);
      inv.add("mat:stick", 32);
      inv.add("mat:iron", 16);
      msg("获得基础建材与材料");
      refreshHUD();
      break;
    case "clearmobs":
      clearMobs(); msg("已清除所有生物");
      break;
    default:
      msg(`未知命令: /${cmd}（/help 查看帮助）`);
  }
}
consoleInput.addEventListener("keydown", (e: KeyboardEvent) => {
  e.stopPropagation();
  if (e.code === "Enter") { execCommand(consoleInput.value); closeConsole(); }
});
chatInput.addEventListener("keydown", (e: KeyboardEvent) => {
  e.stopPropagation();
  if (e.code === "Enter") {
    const text = chatInput.value.trim();
    if (text) { if (net.connected) net.sendChat(text); else addChat("你", text); }
    closeChat();
  }
});

// ---------- 管理面板 ----------
panel.innerHTML = `
  <h2>⚙ 管理面板 <span style="float:right;cursor:pointer" id="panelClose">✕</span></h2>
  <div class="psec"><b>时间</b>
    <button class="pbtn" id="tDay">白天</button><button class="pbtn" id="tNoon">正午</button>
    <button class="pbtn" id="tNight">夜晚</button>
    <span id="clock" style="margin-left:8px;color:#9df"></span></div>
  <div class="psec"><b>天气</b>
    <button class="pbtn" id="wClear">晴</button><button class="pbtn" id="wRain">雨</button></div>
  <div class="psec"><b>生物</b><div id="spawnBtns"></div>
    <button class="pbtn" id="clearMb">清除全部</button></div>
  <div class="psec"><b>模式</b>
    <button class="pbtn" id="flyBtn">切换飞行</button>
    <button class="pbtn" id="hbBtn">碰撞箱(F3)</button>
    <button class="pbtn" id="giveBlocks">获取建材</button></div>
  <div class="psec"><b>联机（LAN）</b>
    <div id="netInfo" style="color:#9df"></div>
    <button class="pbtn" id="openConnectBtn">连接服务器…</button></div>
  <div class="psec"><b>状态</b><div id="shopCoins" style="color:#ffd54a"></div>
    <div id="invHint2" style="color:#9df"></div></div>
  <div class="psec"><b>封禁管理</b><div id="banBox"></div></div>`;
document.getElementById("panelClose")!.addEventListener("click", closePanel);
document.getElementById("tDay")!.addEventListener("click", () => env.setTime(0.1));
document.getElementById("tNoon")!.addEventListener("click", () => env.setTime(0.25));
document.getElementById("tNight")!.addEventListener("click", () => env.setTime(0.7));
document.getElementById("wClear")!.addEventListener("click", () => env.setWeather("clear"));
document.getElementById("wRain")!.addEventListener("click", () => env.setWeather("rain"));
document.getElementById("clearMb")!.addEventListener("click", () => { clearMobs(); msg("已清除所有生物"); });
document.getElementById("flyBtn")!.addEventListener("click", () => { player.fly = !player.fly; msg(`飞行: ${player.fly ? "开" : "关"}`); });
document.getElementById("hbBtn")!.addEventListener("click", () => toggleHitboxes());
document.getElementById("giveBlocks")!.addEventListener("click", () => execCommand("/blocks"));
document.getElementById("openConnectBtn")!.addEventListener("click", () => {
  panelOpen = false; panel.style.display = "none";
  openConnect();
});
(document.getElementById("invClose") as HTMLElement).addEventListener("click", closeInventory);

for (const key of Object.keys(MOB_TYPES)) {
  const b = document.createElement("button");
  b.className = "pbtn";
  b.textContent = `生成${MOB_TYPES[key].name}`;
  b.addEventListener("click", () => {
    const p = randomSurfacePos(player.pos, 4, 10);
    if (p) spawnMob(key, p.x, p.z);
  });
  document.getElementById("spawnBtns")!.appendChild(b);
}
function renderShopInfo(): void {
  const c = document.getElementById("shopCoins");
  const h = document.getElementById("invHint2");
  if (c) c.textContent = `金币 ${player.coins} · 血量 ${player.hp}/20 · 饥饿 ${player.hunger}/20`;
  if (h) h.textContent = `背包物品 ${inv.slots.filter(Boolean).length}/36 · 按 E 打开背包与合成`;
}
function renderBanList(): void {
  const box = document.getElementById("banBox")!;
  box.innerHTML = "";
  for (const key of Object.keys(MOB_TYPES)) {
    const b = document.createElement("button");
    b.className = "pbtn";
    b.textContent = `${banned.has(key) ? "解封" : "封禁"} ${MOB_TYPES[key].name}`;
    b.addEventListener("click", () => {
      if (banned.has(key)) { banned.delete(key); msg(`已解封 ${MOB_TYPES[key].name}`); }
      else { banned.add(key); removeMobsOfType(key); msg(`已封禁 ${MOB_TYPES[key].name}`); }
      localStorage.setItem("mc_banned", JSON.stringify([...banned]));
      renderBanList();
    });
    box.appendChild(b);
  }
}

// ---------- 初始生物 ----------
function spawnInitialMobs(): void {
  const plan: Array<[string, number]> = [["pig", 5], ["sheep", 4], ["chicken", 4], ["cow", 3], ["zombie", 2], ["spider", 2]];
  for (const [type, count] of plan) {
    if (banned.has(type)) continue;
    for (let i = 0; i < count; i++) {
      const p = randomSurfacePos(player.pos, 12, 34);
      if (p) spawnMob(type, p.x, p.z);
    }
  }
}
spawnInitialMobs();

// 调试/截图模式
const debugParams = new URLSearchParams(location.search);
if (debugParams.has("debug")) {
  overlay.style.display = "none";
  player.pitch = -0.32;
  player.yaw = 0.65;
  if (debugParams.has("up")) player.pos.y += 8;
  if (debugParams.has("night")) env.setTime(0.7);
  if (debugParams.has("day")) env.setTime(0.25);
  if (debugParams.has("mobs")) {
    const types = Object.keys(MOB_TYPES);
    types.forEach((t, i) => {
      const a = player.yaw + (i - 2.5) * 0.28;
      spawnMob(t, player.pos.x + Math.sin(a) * 6, player.pos.z + Math.cos(a) * 6);
    });
    player.pitch = -0.12;
  }
  if (debugParams.has("inv")) openInventory();
  if (debugParams.has("nofog")) { scene.fogStart = 2000; scene.fogEnd = 4000; }
  if (debugParams.has("lake")) {
    // 找一处"浅水靠岸"的位置（水面上方是空气、旁边是陆地），站到岸上看透明度
    let bx = -1, bz = -1, by = 0;
    for (let z = 3; z < SZ - 3 && bx < 0; z++)
      for (let x = 8; x < SX - 8; x++) {
        if (getBlock(x, SEA_LEVEL - 1, z) !== B.WATER) continue;
        if (getBlock(x, SEA_LEVEL, z) !== B.AIR) continue;
        if (getBlock(x + 2, SEA_LEVEL - 1, z) === B.WATER) continue;   // 要求近岸
        if (getBlock(x, SEA_LEVEL - 3, z) !== B.WATER) continue;        // 要求浅水
        bx = x; bz = z; by = SEA_LEVEL; break;
      }
    if (bx >= 0) {
      // 站在岸上，朝水面俯视
      player.pos.set(bx + 6.5, by + 3, bz + 0.5);
      player.fly = true; player.yaw = -Math.PI / 2; player.pitch = 0.45;
    }
  }
  // 截图辅助：?village 飞到第一座村庄上空；?at=x,y,z &look=yaw,pitch 精确定位
  if (debugParams.has("village") && villageSites.length > 0) {
    const v = villageSites[0];
    player.pos.set(v.x + 0.5, v.base + 10, v.z + 22.5);
    player.fly = true;
    player.yaw = Math.PI; player.pitch = 0.42;
  }
  const atParam = debugParams.get("at");
  if (atParam) {
    const [ax, ay, az] = atParam.split(",").map(Number);
    player.pos.set(ax, ay, az); player.fly = true;
  }
  const lookParam = debugParams.get("look");
  if (lookParam) {
    const [ly, lp] = lookParam.split(",").map(Number);
    player.yaw = ly; player.pitch = lp;
  }
  if (villageSites.length > 0) console.log("villages:", JSON.stringify(villageSites));
  const tipDbg = document.getElementById("tip");
  if (tipDbg) tipDbg.textContent =
    `pos ${player.pos.x.toFixed(0)},${player.pos.y.toFixed(0)},${player.pos.z.toFixed(0)} | ` +
    `villages ${villageSites.map(v => `${v.x},${v.base},${v.z}`).join(" ")}`;
  // 水面档位：?water=shader|flat|off
  const waterParam = debugParams.get("water");
  if (waterParam === "flat" || waterParam === "off" || waterParam === "shader") setWaterMode(waterParam);
}
// 自适应分辨率关闭开关（性能测试需要固定分辨率才能横向比较）
let autoRes = !debugParams.has("noadapt");

// ---------- 主循环 ----------
let lastFps = 0;
let lowFpsStreak = 0;
let hwScale = 1;
let nightT = 12;
let clockT = 0;
let hungerAcc = 0;
let starveT = 0;
let netT = 0;
const _fwd = new BABYLON.Vector3();
const _right = new BABYLON.Vector3();
const _move = new BABYLON.Vector3();
const _camBack = new BABYLON.Vector3();
const _camDir = new BABYLON.Vector3();
const THIRD_PERSON_DIST = 4.2;
let sprinting = false;

// 分轴移动（模块级函数：避免每帧创建闭包）
function tryMoveAxis(axis: "x" | "y" | "z", delta: number): void {
  const p = player;
  if (delta === 0) return;
  const old = p.pos[axis];
  p.pos[axis] += delta;
  if (boxCollides(p.pos.x, p.pos.y, p.pos.z, p.hw, p.height)) {
    p.pos[axis] = old;
    if (axis === "y") { if (delta < 0) p.onGround = true; p.vel.y = 0; }
  } else if (axis === "y" && delta < 0) p.onGround = false;
}

scene.onBeforeRenderObservable.add(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  const p = player;
  sprinting = false;

  if (!dead) {
    _fwd.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    _right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    _move.setAll(0);
    if (keys["KeyW"]) _move.addInPlace(_fwd);
    if (keys["KeyS"]) _move.subtractInPlace(_fwd);
    if (keys["KeyD"]) _move.addInPlace(_right);
    if (keys["KeyA"]) _move.subtractInPlace(_right);
    const sprint = (keys["ShiftLeft"] || keys["ShiftRight"]) && p.hunger > 6;
    sprinting = sprint && !p.fly;
    // 疾跑大幅提速（步行 6 / 疾跑 15 / 飞行 22）
    const speed = p.fly ? 22 : sprint ? 15 : 6;
    if (_move.lengthSquared() > 0) _move.normalize().scaleInPlace(speed);

    if (p.fly) {
      p.vel.copyFrom(_move);
      if (keys["Space"]) p.vel.y = 14;
      else if (sprint) p.vel.y = -14;
      else p.vel.y = 0;
    } else {
      p.vel.x = _move.x; p.vel.z = _move.z;
      p.vel.y -= GRAVITY * dt;
      if (p.onGround && keys["Space"]) { p.vel.y = JUMP_V; p.onGround = false; }
      if (p.vel.y < -40) p.vel.y = -40;
    }
    tryMoveAxis("y", p.vel.y * dt);
    tryMoveAxis("x", p.vel.x * dt);
    tryMoveAxis("z", p.vel.z * dt);
    if (p.pos.y < -5) damagePlayer(99);

    // 饥饿
    const moving = Math.hypot(p.vel.x, p.vel.z) > 0.5;
    hungerAcc += dt * (moving ? (sprint ? 2.2 : 1.2) : 0.45);
    if (hungerAcc > 20) {
      hungerAcc = 0;
      if (p.hunger > 0) { p.hunger--; refreshHUD(); }
    }
    if (p.hunger <= 0) {
      starveT += dt;
      if (starveT > 9) { starveT = 0; damagePlayer(1); }
    } else starveT = 0;

    // 回血（需要饥饿值）
    regenTimer -= dt;
    if (regenTimer <= 0 && p.hp < 20 && p.hunger > 8) {
      p.hp = Math.min(20, p.hp + 1);
      regenTimer = 6;
      refreshHUD();
    }
    eatCd = Math.max(0, eatCd - dt);
  }

  // 疾跑时轻微拉伸视野，速度感更强（帧率无关的指数趋近）
  camera.fov += ((sprinting ? 1.24 : 1.1) - camera.fov) * Math.min(1, dt * 8);
  camera.position.set(p.pos.x, p.pos.y + p.eye, p.pos.z);
  camera.rotation.set(p.pitch, p.yaw, 0);

  // 玩家模型始终跟随脚下位置；第三人称时显示并后拉相机
  playerAvatar.position.set(p.pos.x, p.pos.y, p.pos.z);
  playerAvatar.rotation.y = p.yaw;
  playerAvatar.setEnabled(thirdPerson && !dead);
  if (thirdPerson && !dead) {
    // 相机后拉时若被方块挡住则拉近，避免穿墙/贴进地表
    const cp = Math.cos(p.pitch), sp = Math.sin(p.pitch);
    _camBack.set(-Math.sin(p.yaw) * cp, sp, -Math.cos(p.yaw) * cp);
    let dist = THIRD_PERSON_DIST;
    const camHit = raycastBlock(camera.position, _camBack, THIRD_PERSON_DIST);
    if (camHit) dist = Math.max(1.6, camHit.dist - 0.3);
    camera.position.set(
      p.pos.x + _camBack.x * dist + Math.cos(p.yaw) * 0.55,
      Math.max(p.pos.y + 0.4, p.pos.y + p.eye + _camBack.y * dist),
      p.pos.z + _camBack.z * dist - Math.sin(p.yaw) * 0.55,
    );
  }

  // 挖掘
  if (mouseLeft && locked && !dead) {
    const camPos = camera.globalPosition;
    camera.getDirectionToRef(BABYLON.Axis.Z, _camDir);
    _camDir.normalize();
    const hit = raycastBlock(camPos, _camDir, REACH);
    if (hit) {
      const id = getBlock(hit.x, hit.y, hit.z);
      const def = DEFS[id];
      const k = `${hit.x},${hit.y},${hit.z}`;
      if (def.breakable) {
        if (k !== miningKey) { miningKey = k; miningProgress = 0; }
        miningProgress += (dt * miningSpeedFor(id)) / def.hardness;
        if (miningProgress >= 1) {
          const d = breakBlock(hit.x, hit.y, hit.z);
          if (d) {
            const dropId = d.drop ?? blockItem(d.id);
            if (dropId) inv.add(dropId, 1);
            p.coins += d.coin;
            if (net.connected) net.sendBlock(hit.x, hit.y, hit.z, B.AIR);
            refreshHUD();
          }
          miningProgress = 0; miningKey = null;
        }
      } else miningProgress = 0;
    } else miningProgress = 0;
    if (miningProgress > 0) {
      mineBar.style.display = "block";
      mineFill.style.width = `${Math.min(100, miningProgress * 100)}%`;
    } else mineBar.style.display = "none";
  }

  // 生物
  updateMobs(dt, p.pos, damagePlayer);
  nightT -= dt;
  if (env.isNight && nightT <= 0) {
    nightT = 16;
    const hostile = ["zombie", "spider"].filter(t => !banned.has(t));
    if (hostile.length && countMobs() < 30) {
      const sp = randomSurfacePos(p.pos, 16, 34);
      if (sp) spawnMob(hostile[(Math.random() * hostile.length) | 0], sp.x, sp.z);
    }
  }

  env.update(dt, p.pos);

  // 联机同步
  net.update(dt);
  if (net.connected) {
    netT -= dt;
    if (netT <= 0) { netT = 0.1; net.sendInput(p.pos, p.yaw, p.pitch); }
  }

  // 面板信息
  clockT += dt;
  if (clockT > 1 && panelOpen) {
    clockT = 0;
    const c = document.getElementById("clock");
    if (c) c.textContent = `🕐 ${env.getTimeLabel()} ${env.isRaining ? "🌧" : "☀"}`;
    renderShopInfo();
  }

  const now = performance.now();
  if (now - lastFps > 500) {
    lastFps = now;
    const fps = engine.getFps();
    fpsEl.textContent = `FPS: ${fps.toFixed(0)}`;
    // 动态分辨率：以 60fps 为目标，掉帧时降分辨率（最低 60%），有余量时再升回来
    if (!autoRes) { /* 性能测试模式：分辨率固定，避免测量被自适应掩盖 */ }
    else if (fps < 55) {
      lowFpsStreak++;
      if (lowFpsStreak >= 2 && hwScale < 1.7) {
        lowFpsStreak = 0;
        hwScale = Math.min(1.7, hwScale + 0.15);
        engine.setHardwareScalingLevel(hwScale);
        msg(`性能模式: 渲染分辨率 ${Math.round(100 / hwScale)}%`);
      }
    } else if (fps > 70) {
      lowFpsStreak = 0;
      if (hwScale > 1.001) {
        hwScale = Math.max(1, hwScale - 0.1);
        engine.setHardwareScalingLevel(hwScale);
      }
    } else lowFpsStreak = 0;
  }
});

// ---------- 自动化性能测试钩子（scripts/fps.mjs 使用，不参与游戏逻辑） ----------
interface McDebugApi {
  engine: BABYLON.Engine;
  scene: BABYLON.Scene;
  player: Player;
  setWaterMode: (m: WaterMode) => void;
  getWaterMode: () => WaterMode;
  setAutoRes: (on: boolean) => void;
  setHwScale: (v: number) => void;
  getHwScale: () => number;
  /** 世界编辑（基准脚本用来测"挖/放方块"的耗时与正确性） */
  world: {
    get: (x: number, y: number, z: number) => number;
    break: (x: number, y: number, z: number) => boolean;
    place: (x: number, y: number, z: number, id: number) => boolean;
  };
}
declare global {
  interface Window { __mc?: McDebugApi }
}
window.__mc = {
  engine, scene, player,
  setWaterMode, getWaterMode,
  setAutoRes: (on: boolean) => { autoRes = on; },
  setHwScale: (v: number) => { hwScale = v; engine.setHardwareScalingLevel(v); },
  getHwScale: () => hwScale,
  world: {
    get: getBlock,
    break: (x, y, z) => breakBlock(x, y, z) !== null,
    place: (x, y, z, id) => placeBlock(x, y, z, id).ok,
  },
};

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
tutCloseBtn.addEventListener("click", () => closeTutorial());
// 首次进入自动显示教程（调试/截图模式下不打扰）
if (!localStorage.getItem("mc_tut") && !debugParams.has("debug")) openTutorial();
refreshHUD();
renderInventory();
console.log("OurCraft ready. World:", SX, "x", SZ);
