/* LAN 权威服务器：仅需昵称，上限 10 人。
 * 运行: npm run server   （默认端口 8787）
 * 客户端连接: ws://<房主IP>:8787
 */
import { networkInterfaces } from "node:os";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_PLAYERS = 10;
const LIMIT = 52;          // 建筑高度上限（与客户端一致）
const SIZE = 128;

interface Client {
  id: number;
  ws: WebSocket;
  name: string;
  pos: number[];
  yaw: number;
  pitch: number;
  blockBudget: number;
  lastRefill: number;
  alive: boolean;
}

const clients = new Map<WebSocket, Client>();
const edits = new Map<string, [number, number, number, number]>();
let nextId = 1;

const wss = new WebSocketServer({ port: PORT });

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}
wss.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`端口 ${PORT} 已被占用：可能已有一个联机服务在运行。`);
    console.error(`  先关闭旧进程再重试（Windows: netstat -ano | findstr ${PORT} 找到 PID 后结束它）`);
  } else {
    console.error(`联机服务启动失败: ${err.message}`);
  }
  process.exit(1);
});

wss.on("listening", () => {
  console.log(`OurCraft LAN server listening on port ${PORT} (max ${MAX_PLAYERS} players)`);
  for (const a of lanAddresses()) {
    console.log(`  游戏页面:  http://${a}:5173`);
    console.log(`  联机地址:  ws://${a}:${PORT}`);
  }
  console.log(`提示: 其它设备连不上通常是 Windows 防火墙拦截入站，管理员 PowerShell 执行：
  New-NetFirewallRule -DisplayName "OurCraft 5173" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Any
  New-NetFirewallRule -DisplayName "OurCraft 8787" -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Allow -Profile Any
详见 docs/network-troubleshooting.md`);
});

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj: unknown, exclude?: WebSocket): void {
  const data = JSON.stringify(obj);
  for (const ws of clients.keys()) {
    if (ws === exclude) continue;
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}
function playerList(): Array<{ id: number; name: string }> {
  return [...clients.values()].filter(c => c.alive).map(c => ({ id: c.id, name: c.name }));
}

wss.on("connection", (ws: WebSocket) => {
  if (clients.size >= MAX_PLAYERS) {
    send(ws, { t: "error", msg: `房间已满（${MAX_PLAYERS} 人）` });
    ws.close();
    return;
  }
  const client: Client = {
    id: nextId++, ws, name: "", pos: [64, 40, 64], yaw: 0, pitch: 0,
    blockBudget: 10, lastRefill: Date.now(), alive: false,
  };
  clients.set(ws, client);

  const timeout = setTimeout(() => {
    if (!client.alive) ws.close();
  }, 5000);

  ws.on("message", (raw: WebSocket.RawData) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
    if (msg.t === "hello") {
      const name = String(msg.name ?? "").trim().slice(0, 16) || `玩家${client.id}`;
      client.name = name;
      client.alive = true;
      clearTimeout(timeout);
      send(ws, {
        t: "welcome", id: client.id,
        players: playerList(), edits: [...edits.values()], max: MAX_PLAYERS,
      });
      broadcast({ t: "join", id: client.id, name }, ws);
      broadcast({ t: "chat", from: "系统", text: `${name} 加入了游戏` }, ws);
      console.log(`[join] ${name} (${clients.size}/${MAX_PLAYERS})`);
      return;
    }
    if (!client.alive) return;

    if (msg.t === "input") {
      const p = msg.p as number[];
      if (Array.isArray(p) && p.length === 3 && p.every(v => typeof v === "number" && Number.isFinite(v))) {
        client.pos = p;
        client.yaw = Number(msg.yaw) || 0;
        client.pitch = Number(msg.pitch) || 0;
      }
    } else if (msg.t === "block") {
      const b = msg.b as number[];
      if (!Array.isArray(b) || b.length !== 4) return;
      const [x, y, z, id] = b.map(Number);
      if (![x, y, z, id].every(Number.isInteger)) return;
      if (x < 0 || z < 0 || x >= SIZE || z >= SIZE || y < 0 || y > LIMIT) return;
      if (id < 0 || id > 32) return;
      // 频率限制：每秒最多 10 次方块操作
      const now = Date.now();
      if (now - client.lastRefill > 1000) {
        client.lastRefill = now;
        client.blockBudget = 10;
      }
      if (--client.blockBudget < 0) return;
      // 距离校验（允许 2 格误差，防止超距放置）
      const dx = x + 0.5 - client.pos[0], dy = y + 0.5 - client.pos[1], dz = z + 0.5 - client.pos[2];
      if (dx * dx + dy * dy + dz * dz > 12 * 12) return;
      edits.set(`${x},${y},${z}`, [x, y, z, id]);
      broadcast({ t: "blocks", changes: [[x, y, z, id]] }, ws);
    } else if (msg.t === "chat") {
      const text = String(msg.text ?? "").trim().slice(0, 200);
      if (!text) return;
      broadcast({ t: "chat", from: client.name, text });
    }
  });

  ws.on("close", () => {
    clearTimeout(timeout);
    const wasAlive = client.alive;
    clients.delete(ws);
    if (wasAlive) {
      broadcast({ t: "leave", id: client.id });
      broadcast({ t: "chat", from: "系统", text: `${client.name} 离开了游戏` });
      console.log(`[left] ${client.name} (${clients.size}/${MAX_PLAYERS})`);
    }
  });
});

// 10Hz 广播玩家状态
setInterval(() => {
  const players = [...clients.values()].filter(c => c.alive).map(c => ({
    id: c.id, p: c.pos.map(v => Math.round(v * 100) / 100), yaw: c.yaw,
  }));
  if (players.length > 0) broadcast({ t: "state", players });
}, 100);
