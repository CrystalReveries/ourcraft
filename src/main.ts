/* 主模块：玩家、输入、背包/合成/饥饿、挖掘与战斗、HUD、面板、命令、LAN 联机 */
import * as BABYLON from "@babylonjs/core";
import {
  SX, SZ, REACH, ATTACK_REACH, GRAVITY, JUMP_V, B, DEFS,
} from "./config";
import {
  Inventory, RECIPES, craft, canCraft, ITEMS, itemName, itemColor, blockItem,
  bestTool, bestSwordDamage, toolLabel,
} from "./items";
import {
  initWorld, generateWorld, buildAllInstances, getBlock, boxCollides,
  breakBlock, placeBlock, raycastBlock, toggleLeverAt, setBlockRemote, surfaceY, leverOn,
} from "./world";
import {
  initMobs, spawnMob, updateMobs, pickMobRay, damageMob, removeMobsOfType,
  clearMobs, countMobs, toggleHitboxes, MOB_TYPES, randomSurfacePos,
} from "./mobs";
import { Environment } from "./systems";
import { NetClient } from "./net";

// ---------- 引擎 ----------
const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
const engine = new BABYLON.Engine(canvas, true, { stencil: false });
const scene = new BABYLON.Scene(engine);
scene.skipPointerMovePicking = true;
scene.blockMaterialDirtyMechanism = true;

const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.1), scene);
hemi.intensity = 0.85;
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
  const x = SX >> 1, z = SZ >> 1;
  spawnPoint = new BABYLON.Vector3(x + 0.5, surfaceY(x, z) + 0.05, z + 0.5);
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

let dead = false;
let locked = false;
let panelOpen = false;
let consoleOpen = false;
let invOpen = false;
let chatOpen = false;
let connectOpen = false;
const uiOpen = (): boolean => panelOpen || consoleOpen || invOpen || chatOpen || connectOpen;

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
function renderHotbar(): void {
  hotbarEl.innerHTML = "";
  for (let i = 0; i < 9; i++) {
    const slot = inv.slots[i];
    const d = document.createElement("div");
    d.className = "slot" + (i === inv.selected ? " active" : "");
    if (slot) {
      d.style.background = itemColor(slot.id) + "aa";
      d.textContent = `${i + 1}\n${itemName(slot.id)}${slot.count > 1 ? " x" + slot.count : ""}`;
    } else {
      d.textContent = `${i + 1}\n空`;
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
      d.textContent = `${itemName(slot.id)}${slot.count > 1 ? " ×" + slot.count : ""}`;
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
}

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

scene.onBeforeRenderObservable.add(() => {
  const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
  const p = player;

  if (!dead) {
    _fwd.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
    _right.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
    _move.setAll(0);
    if (keys["KeyW"]) _move.addInPlace(_fwd);
    if (keys["KeyS"]) _move.subtractInPlace(_fwd);
    if (keys["KeyD"]) _move.addInPlace(_right);
    if (keys["KeyA"]) _move.subtractInPlace(_right);
    const sprint = (keys["ShiftLeft"] || keys["ShiftRight"]) && p.hunger > 6;
    const speed = p.fly ? 14 : sprint ? 9 : 5.5;
    if (_move.lengthSquared() > 0) _move.normalize().scaleInPlace(speed);

    if (p.fly) {
      p.vel.copyFrom(_move);
      if (keys["Space"]) p.vel.y = 10;
      else if (sprint) p.vel.y = -10;
      else p.vel.y = 0;
    } else {
      p.vel.x = _move.x; p.vel.z = _move.z;
      p.vel.y -= GRAVITY * dt;
      if (p.onGround && keys["Space"]) { p.vel.y = JUMP_V; p.onGround = false; }
      if (p.vel.y < -40) p.vel.y = -40;
    }
    const tryAxis = (axis: "x" | "y" | "z", delta: number): void => {
      if (delta === 0) return;
      const old = p.pos[axis];
      p.pos[axis] += delta;
      if (boxCollides(p.pos.x, p.pos.y, p.pos.z, p.hw, p.height)) {
        p.pos[axis] = old;
        if (axis === "y") { if (delta < 0) p.onGround = true; p.vel.y = 0; }
      } else if (axis === "y" && delta < 0) p.onGround = false;
    };
    tryAxis("y", p.vel.y * dt);
    tryAxis("x", p.vel.x * dt);
    tryAxis("z", p.vel.z * dt);
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

  camera.position.set(p.pos.x, p.pos.y + p.eye, p.pos.z);
  camera.rotation.set(p.pitch, p.yaw, 0);

  // 挖掘
  if (mouseLeft && locked && !dead) {
    const camPos = camera.globalPosition;
    const camDir = camera.getDirection(BABYLON.Axis.Z).normalize();
    const hit = raycastBlock(camPos, camDir, REACH);
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
    if (fps < 24 && hwScale < 1.5) {
      lowFpsStreak++;
      if (lowFpsStreak >= 3) {
        lowFpsStreak = 0;
        hwScale += 0.25;
        engine.setHardwareScalingLevel(hwScale);
        msg(`性能模式: 分辨率降至 ${Math.round(100 / hwScale)}%`);
      }
    } else lowFpsStreak = 0;
  }
});

engine.runRenderLoop(() => scene.render());
window.addEventListener("resize", () => engine.resize());
refreshHUD();
renderInventory();
console.log("MiniCraft v2 ready. World:", SX, "x", SZ);
