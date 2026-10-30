/* LAN 联机客户端：仅需昵称，无注册。房主运行 `npm run server`。
 * 服务器权威世界（方块差量），客户端负责渲染与移动。
 */
import * as BABYLON from "@babylonjs/core";
import "@babylonjs/loaders/glTF";

export interface NetHandlers {
  onBlock: (x: number, y: number, z: number, id: number) => void;
  onStatus: (text: string, connected: boolean) => void;
  onChat: (from: string, text: string) => void;
  onPlayers: (names: string[]) => void;
}

interface RemotePlayer {
  name: string;
  root: BABYLON.TransformNode;
  target: BABYLON.Vector3;
  pos: BABYLON.Vector3;
  yawTarget: number;
  yaw: number;
  moving: boolean;
  idle?: BABYLON.AnimationGroup;
  walk?: BABYLON.AnimationGroup;
}

type Msg =
  | { t: "welcome"; id: number; players: Array<{ id: number; name: string }>; edits: number[][]; max: number }
  | { t: "join"; id: number; name: string }
  | { t: "leave"; id: number }
  | { t: "state"; players: Array<{ id: number; p: number[]; yaw: number }> }
  | { t: "blocks"; changes: number[][] }
  | { t: "chat"; from: string; text: string }
  | { t: "error"; msg: string };

export class NetClient {
  private ws: WebSocket | null = null;
  private scene: BABYLON.Scene;
  private handlers: NetHandlers;
  private remotes = new Map<number, RemotePlayer>();
  private myId = -1;
  connected = false;

  constructor(scene: BABYLON.Scene, handlers: NetHandlers) {
    this.scene = scene;
    this.handlers = handlers;
  }

  connect(url: string, name: string, pos: BABYLON.Vector3, yaw: number): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(url);
      } catch (e) {
        reject(e as Error);
        return;
      }
      const ws = this.ws;
      const timeout = setTimeout(() => {
        try { ws.close(); } catch { /* noop */ }
        reject(new Error("连接超时"));
      }, 6000);

      ws.onopen = () => {
        this.send({ t: "hello", name });
        this.send({ t: "input", p: [pos.x, pos.y, pos.z], yaw });
      };
      ws.onmessage = (ev: MessageEvent) => {
        clearTimeout(timeout);
        let msg: Msg;
        try { msg = JSON.parse(String(ev.data)) as Msg; } catch { return; }
        this.handle(msg);
        if (msg.t === "welcome") {
          this.connected = true;
          this.handlers.onStatus(`已连接（${name}）`, true);
          resolve();
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        if (!this.connected) reject(new Error("无法连接服务器"));
      };
      ws.onclose = () => {
        this.connected = false;
        this.handlers.onStatus("未连接", false);
        this.clearRemotes();
      };
    });
  }

  private handle(msg: Msg): void {
    switch (msg.t) {
      case "welcome": {
        this.myId = msg.id;
        for (const p of msg.players) this.addRemote(p.id, p.name);
        for (const e of msg.edits) this.handlers.onBlock(e[0], e[1], e[2], e[3]);
        this.handlers.onPlayers(msg.players.map(p => p.name));
        this.handlers.onChat("系统", `已加入服务器（上限 ${msg.max} 人）`);
        break;
      }
      case "join":
        if (msg.id !== this.myId) {
          this.addRemote(msg.id, msg.name);
          this.handlers.onChat("系统", `${msg.name} 加入了游戏`);
        }
        break;
      case "leave":
        this.removeRemote(msg.id);
        break;
      case "state":
        for (const p of msg.players) {
          if (p.id === this.myId) continue;
          const r = this.remotes.get(p.id);
          if (r) {
            r.target.set(p.p[0], p.p[1], p.p[2]);
            r.yawTarget = p.yaw;
          }
        }
        break;
      case "blocks":
        for (const e of msg.changes) this.handlers.onBlock(e[0], e[1], e[2], e[3]);
        break;
      case "chat":
        this.handlers.onChat(msg.from, msg.text);
        break;
      case "error":
        this.handlers.onChat("系统", msg.msg);
        break;
    }
  }

  private addRemote(id: number, name: string): void {
    if (this.remotes.has(id)) return;
    const root = new BABYLON.TransformNode("remote_" + id, this.scene);
    const color = new BABYLON.Color3(((id * 97) % 200) / 255 + 0.2, ((id * 53) % 200) / 255 + 0.2, ((id * 29) % 200) / 255 + 0.2);
    const mat = new BABYLON.StandardMaterial("remoteMat_" + id, this.scene);
    mat.diffuseColor = color;
    mat.specularColor = BABYLON.Color3.Black();
    const body = BABYLON.MeshBuilder.CreateBox("rb", { width: 0.55, height: 1.1, depth: 0.32 }, this.scene);
    body.material = mat; body.position.y = 1.15; body.parent = root;
    const head = BABYLON.MeshBuilder.CreateBox("rh", { size: 0.42 }, this.scene);
    head.material = mat; head.position.y = 1.9; head.parent = root;
    const legL = BABYLON.MeshBuilder.CreateBox("rl", { width: 0.18, height: 0.6, depth: 0.18 }, this.scene);
    legL.material = mat; legL.position.set(-0.14, 0.3, 0); legL.parent = root;
    const legR = legL.clone("rr");
    legR.position.x = 0.14; legR.parent = root;

    // 名字标签
    const tex = new BABYLON.DynamicTexture("nameTex_" + id, { width: 256, height: 64 }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 256, 64);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.fillRect(0, 8, 256, 48);
    ctx.fillStyle = "#fff";
    ctx.font = "bold 30px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, 128, 32);
    tex.update();
    const label = BABYLON.MeshBuilder.CreatePlane("label_" + id, { width: 1.6, height: 0.4 }, this.scene);
    const lmat = new BABYLON.StandardMaterial("labelMat_" + id, this.scene);
    lmat.diffuseTexture = tex;
    lmat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    lmat.disableLighting = true;
    lmat.backFaceCulling = false;
    label.material = lmat;
    label.position.y = 2.35;
    label.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    label.parent = root;

    const pos = new BABYLON.Vector3(0, 30, 0);
    this.remotes.set(id, { name, root, target: pos.clone(), pos: pos.clone(), yawTarget: 0, yaw: 0, moving: false });
    void this.loadHero(id, root, [body, head, legL, legR]);
  }

  private async loadHero(id: number, root: BABYLON.TransformNode, fallback: BABYLON.Mesh[]): Promise<void> {
    try {
      const result = await BABYLON.SceneLoader.ImportMeshAsync("", "/assets/characters/", "hero.glb", this.scene);
      const remote = this.remotes.get(id);
      if (!remote) {
        result.animationGroups.forEach(animation => animation.dispose());
        result.meshes.forEach(mesh => mesh.dispose());
        return;
      }
      result.meshes[0].parent = root;
      fallback.forEach(mesh => mesh.dispose());
      remote.idle = result.animationGroups.find(animation => animation.name === "Idle");
      remote.walk = result.animationGroups.find(animation => animation.name === "Walk");
      remote.idle?.start(true);
    } catch (error) {
      console.warn("主角模型加载失败，使用备用盒状角色。", error);
    }
  }

  private removeRemote(id: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.idle?.dispose();
    r.walk?.dispose();
    r.root.getChildMeshes().forEach(m => m.dispose());
    r.root.dispose();
    this.remotes.delete(id);
  }
  private clearRemotes(): void {
    for (const id of Array.from(this.remotes.keys())) this.removeRemote(id);
  }

  update(dt: number): void {
    for (const r of this.remotes.values()) {
      r.pos = BABYLON.Vector3.Lerp(r.pos, r.target, Math.min(1, dt * 8));
      r.yaw += (r.yawTarget - r.yaw) * Math.min(1, dt * 8);
      r.root.position.copyFrom(r.pos);
      r.root.rotation.y = r.yaw;
      const moving = BABYLON.Vector3.DistanceSquared(r.pos, r.target) > 0.0025;
      if (moving !== r.moving) {
        r.moving = moving;
        r.idle?.stop();
        r.walk?.stop();
        (moving ? r.walk : r.idle)?.start(true);
      }
    }
  }

  sendBlock(x: number, y: number, z: number, id: number): void {
    this.send({ t: "block", b: [x, y, z, id] });
  }
  sendInput(p: BABYLON.Vector3, yaw: number, pitch: number): void {
    this.send({ t: "input", p: [round2(p.x), round2(p.y), round2(p.z)], yaw: round2(yaw), pitch: round2(pitch) });
  }
  sendChat(text: string): void {
    this.send({ t: "chat", text });
  }
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
    this.clearRemotes();
  }
  private send(obj: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}
const round2 = (v: number): number => Math.round(v * 100) / 100;
