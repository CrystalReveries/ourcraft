#!/usr/bin/env node
/**
 * Automated FPS benchmark: headed local Chrome + Playwright.
 *
 * 故意只保留两个采样区域（够用即可，不做全景覆盖）：
 *   - water   : 岸边看整片海面，衡量水面/半透明开销
 *   - village : 村庄内部，可见区块最多、几何最复杂的场景
 *
 * - Uses the locally installed Chrome (channel: "chrome"), so no browser download.
 * - Uncaps rAF (--disable-gpu-vsync --disable-frame-rate-limit) so the numbers
 *   measure real throughput instead of the monitor refresh ceiling.
 * - Disables the in-game adaptive resolution (?noadapt) so scenarios stay comparable.
 *
 * Usage:
 *   npm run fps                       # water + village，2s warmup + 3s 采样
 *   npm run fps -- --edit             # 附加：挖/放耗时与正确性
 *   npm run fps -- --burst            # 附加：快速建造（每帧多次编辑）的帧率下限
 *   npm run fps -- --scenario=village # 只跑一个场景
 *   npm run fps -- --vsync            # 保留垂直同步（测"能不能稳 60"）
 *   npm run fps -- --json             # 额外输出原始 JSON
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import path from "node:path";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => args.includes(`--${name}`);

const BASE = opt("url", "http://127.0.0.1:5173").replace(/\/$/, "");
const WARMUP = Number(opt("warmup", 2000));
const SAMPLE = Number(opt("seconds", 3000));
const ONLY = opt("scenario", "all");
const VIEWPORT = opt("viewport", "1600x900");
const HWSCALE = Number(opt("hwscale", 1));
const SHOT_DIR = opt("shot", "");

/** Each scenario = one page load; `steps` run inside the page before sampling. */
const SCENARIOS = [
  { name: "water", query: "?debug&day&noadapt&lake" },
  { name: "water-off", query: "?debug&day&noadapt&lake", steps: [`__mc.setWaterMode("off")`] },
  { name: "village", query: "?debug&day&noadapt&village", edit: true },
];

async function serverAlive(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureDevServer() {
  if (await serverAlive(BASE)) return null;
  const port = new URL(BASE).port || "5173";
  console.log(`[fps] dev server not reachable, starting vite on ${port} ...`);
  const child = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["vite", "--host", "127.0.0.1", "--port", port, "--strictPort"],
    { cwd: path.resolve(process.cwd()), stdio: "ignore", shell: process.platform === "win32" },
  );
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await serverAlive(BASE)) return child;
  }
  child.kill();
  throw new Error("vite dev server did not start within 30s");
}

/** Runs in the page: record frame timestamps for `ms`, return stats. */
const sampleInPage = async ({ ms }) => {
  const mc = window.__mc;
  if (!mc) throw new Error("window.__mc missing (stale build?)");
  const t = [];
  const obs = mc.scene.onAfterRenderObservable.add(() => t.push(performance.now()));
  // Wrap scene.render to separate CPU (JS) cost from GPU cost: small CPU time with
  // a big frame interval means we are GPU/fill-rate bound, not JS bound.
  const origRender = mc.scene.render.bind(mc.scene);
  let cpuSum = 0;
  let cpuN = 0;
  mc.scene.render = () => {
    const t0 = performance.now();
    origRender();
    cpuSum += performance.now() - t0;
    cpuN++;
  };
  await new Promise((r) => setTimeout(r, ms));
  mc.scene.render = origRender;
  mc.scene.onAfterRenderObservable.remove(obs);
  const cpuMs = cpuN ? cpuSum / cpuN : 0;

  const dt = [];
  for (let i = 1; i < t.length; i++) dt.push(t[i] - t[i - 1]);
  dt.sort((a, b) => a - b);
  const pick = (p) => (dt.length ? dt[Math.min(dt.length - 1, Math.floor(dt.length * p))] : 0);
  const avg = dt.reduce((a, b) => a + b, 0) / (dt.length || 1);
  return {
    frames: dt.length,
    fps: avg > 0 ? 1000 / avg : 0,
    fpsP1: pick(0.99) > 0 ? 1000 / pick(0.99) : 0, // worst 1% frames
    fpsP50: pick(0.5) > 0 ? 1000 / pick(0.5) : 0,
    frameMs: avg,
    cpuMs,
    engineFps: mc.engine.getFps(),
    hwScale: mc.getHwScale(),
    water: mc.getWaterMode(),
    activeMeshes: mc.scene.getActiveMeshes().length,
    drawCalls: mc.engine._drawCalls?.current ?? -1,
  };
};

/** Break/place the same block `count` times and time each edit (chunk rebuild cost). */
const editProbe = async ({ count }) => {
  const mc = window.__mc;
  const px = Math.floor(mc.player.pos.x), pz = Math.floor(mc.player.pos.z);
  // 12=bedrock / 29=water：不可破坏。在玩家周围找一根"顶面暴露的普通方块"柱子
  let bx = -1, by = -1, bz = -1, id = 0;
  outer:
  for (let r = 1; r <= 10 && bx < 0; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const x = px + dx, z = pz + dz;
        if (mc.world.get(x, 40, z) !== 0) continue;      // 上空必须通
        for (let y = 58; y > 2; y--) {
          const cur = mc.world.get(x, y, z);
          if (cur === 0) continue;
          if (cur === 12 || cur === 29) break;
          if (mc.world.get(x, y + 1, z) !== 0) break;
          if (mc.world.break(x, y, z) && mc.world.place(x, y, z, cur)) {
            bx = x; by = y; bz = z; id = cur;
            break outer;
          }
          break;
        }
      }
  if (bx < 0) return { error: "no editable block found" };
  const breakMs = [], placeMs = [];
  for (let i = 0; i < count; i++) {
    const t0 = performance.now();
    mc.world.break(bx, by, bz);
    breakMs.push(performance.now() - t0);
    const t1 = performance.now();
    mc.world.place(bx, by, bz, id);
    placeMs.push(performance.now() - t1);
    await new Promise((r) => requestAnimationFrame(r));
  }
  return { block: { bx, by, bz, id }, breakMs, placeMs, restored: mc.world.get(bx, by, bz) === id };
};

/**
 * 快速建造压力测试：每帧做 `perFrame` 次挖+放（同一区块反复重建），
 * 衡量"持续编辑"时区块重建把帧率拉低多少（这才是网格合并唯一可能失效的场景）。
 */
const burstProbe = async ({ perFrame, frames }) => {
  const mc = window.__mc;
  const px = Math.floor(mc.player.pos.x), pz = Math.floor(mc.player.pos.z);
  let bx = -1, by = -1, bz = -1, id = 0;
  outer:
  for (let r = 1; r <= 10 && bx < 0; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const x = px + dx, z = pz + dz;
        if (mc.world.get(x, 40, z) !== 0) continue;
        for (let y = 58; y > 2; y--) {
          const cur = mc.world.get(x, y, z);
          if (cur === 0) continue;
          if (cur === 12 || cur === 29 || mc.world.get(x, y + 1, z) !== 0) break;
          bx = x; by = y; bz = z; id = cur;
          break outer;
        }
      }
  if (bx < 0) return { error: "no editable block found" };

  const cost = [];
  let n = 0;
  const t0 = performance.now();
  await new Promise((resolve) => {
    const step = () => {
      const s = performance.now();
      for (let i = 0; i < perFrame; i++) {
        mc.world.break(bx, by, bz);
        mc.world.place(bx, by, bz, id);
      }
      cost.push(performance.now() - s);
      if (++n >= frames) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const dur = performance.now() - t0;
  return { cost, frames: n, fps: (n / dur) * 1000, perFrame, restored: mc.world.get(bx, by, bz) === id };
};

/** 后台持续编辑（用于在编辑压力下做 CPU profile），立即返回、不 await。 */
const startBurst = async ({ perFrame }) => {
  const mc = window.__mc;
  const px = Math.floor(mc.player.pos.x), pz = Math.floor(mc.player.pos.z);
  let bx = -1, by = -1, bz = -1, id = 0;
  outer:
  for (let r = 1; r <= 10 && bx < 0; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const x = px + dx, z = pz + dz;
        if (mc.world.get(x, 40, z) !== 0) continue;
        for (let y = 58; y > 2; y--) {
          const cur = mc.world.get(x, y, z);
          if (cur === 0) continue;
          if (cur === 12 || cur === 29 || mc.world.get(x, y + 1, z) !== 0) break;
          bx = x; by = y; bz = z; id = cur;
          break outer;
        }
      }
  if (bx < 0) return { error: "no editable block found" };
  window.__burstStop = false;
  const step = () => {
    if (window.__burstStop) return;
    for (let i = 0; i < perFrame; i++) {
      mc.world.break(bx, by, bz);
      mc.world.place(bx, by, bz, id);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return { ok: true };
};

/** Prints renderer + scene composition, to tell GPU-bound from draw-call-bound. */
async function printDiag(page) {
  const d = await page.evaluate(async () => {
    const mc = window.__mc;
    const scene = mc.scene;
    const engine = mc.engine;
    const gl = engine._gl;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const byMat = {};
    let masters = 0;
    let instances = 0;
    const perMaster = [];
    for (const m of scene.meshes) {
      if (m.instances?.length) {
        masters++;
        instances += m.instances.length;
        perMaster.push(`${m.name}=${m.instances.length}`);
      }
    }
    perMaster.sort((a, b) => Number(b.split("=")[1]) - Number(a.split("=")[1]));
    for (const m of scene.getActiveMeshes().data) {
      if (!m) continue;
      const mat = m.material ? m.material.name : "none";
      byMat[mat] = (byMat[mat] ?? 0) + 1;
    }

    // Count real GL draw calls over ~1.5s and divide by frames.
    const counts = { elems: 0, instanced: 0, arrays: 0, frames: 0 };
    const oEl = gl.drawElements.bind(gl);
    const oElI = gl.drawElementsInstanced.bind(gl);
    const oAr = gl.drawArrays.bind(gl);
    gl.drawElements = (...a) => { counts.elems++; return oEl(...a); };
    gl.drawElementsInstanced = (...a) => { counts.instanced++; return oElI(...a); };
    gl.drawArrays = (...a) => { counts.arrays++; return oAr(...a); };
    const obs = scene.onAfterRenderObservable.add(() => counts.frames++);
    await new Promise((r) => setTimeout(r, 1500));
    scene.onAfterRenderObservable.remove(obs);
    gl.drawElements = oEl;
    gl.drawElementsInstanced = oElI;
    gl.drawArrays = oAr;
    const f = Math.max(1, counts.frames);

    // Phase timing: how much of scene.render() is active-mesh evaluation
    // (O(all meshes)) vs the actual draw phase.
    const scene_ = scene;
    const origEval = scene_._evaluateActiveMeshes.bind(scene_);
    let evalMs = 0, evalFrames = 0;
    scene_._evaluateActiveMeshes = (...a) => {
      const t0 = performance.now();
      const r = origEval(...a);
      evalMs += performance.now() - t0;
      evalFrames++;
      return r;
    };
    await new Promise((r) => setTimeout(r, 1500));
    scene_._evaluateActiveMeshes = origEval;

    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown",
      vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : "unknown",
      version: gl.getParameter(gl.VERSION),
      instancedArrays: engine.getCaps().instancedArrays,
      meshes: scene.meshes.length,
      masterMeshes: masters,
      instances,
      activeMeshes: scene.getActiveMeshes().length,
      materials: scene.materials.length,
      drawCalls: engine._drawCalls?.current ?? -1,
      hardwareScaling: engine.getHardwareScalingLevel(),
      glPerFrame: {
        elements: +(counts.elems / f).toFixed(1),
        instanced: +(counts.instanced / f).toFixed(1),
        arrays: +(counts.arrays / f).toFixed(1),
        frames: counts.frames,
      },
      evalMsPerFrame: +(evalMs / Math.max(1, evalFrames)).toFixed(2),
      byMat,
      perMaster,
    };
  });
  console.log(
    `[diag] GPU: ${d.renderer}\n[diag] ${d.version} | instancedArrays=${d.instancedArrays} | hwScale=${d.hardwareScaling}` +
      `\n[diag] meshes=${d.meshes} masters=${d.masterMeshes} instances=${d.instances} active=${d.activeMeshes}` +
      ` materials=${d.materials} drawCalls=${d.drawCalls}`,
  );
  console.log(
    `[diag] GL per frame: drawElements=${d.glPerFrame.elements} instanced=${d.glPerFrame.instanced} ` +
      `arrays=${d.glPerFrame.arrays} (over ${d.glPerFrame.frames} frames)`,
  );
  console.log(`[diag] _evaluateActiveMeshes: ${d.evalMsPerFrame} ms/frame`);
  const top = Object.entries(d.byMat).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log("[diag] active meshes by material: " + top.map(([k, v]) => `${k}=${v}`).join(", "));
  console.log("[diag] instances per master: " + d.perMaster.join(", "));
}

/** V8 CPU profile over `ms`, aggregated by self time. Finds the real hot spot. */
async function printProfile(page, ms) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await sleep(ms);
  const { profile } = await cdp.send("Profiler.stop");
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    const dt = profile.timeDeltas[i] ?? 0;
    if (!node || dt <= 0) continue;
    total += dt;
    const cf = node.callFrame;
    const name = `${cf.functionName || "(anonymous)"} @ ${(cf.url || "").split("/").pop()}:${cf.lineNumber + 1}`;
    self.set(name, (self.get(name) ?? 0) + dt);
  }
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log(`[prof] top self time over ${ms}ms (total ${(total / 1000).toFixed(0)}ms):`);
  for (const [name, us] of top) {
    const pct = ((us / total) * 100).toFixed(1).padStart(5);
    console.log(`  ${pct}%  ${(us / 1000).toFixed(0).padStart(5)}ms  ${name}`);
  }
}

async function main() {
  const devServer = await ensureDevServer();
  if (SHOT_DIR) fs.mkdirSync(SHOT_DIR, { recursive: true });
  const [vw, vh] = VIEWPORT.split("x").map(Number);
  const chromeArgs = flag("vsync")
    ? []
    : ["--disable-gpu-vsync", "--disable-frame-rate-limit", "--disable-frame-rate-limit-compositor"];

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: [`--window-size=${vw},${vh + 120}`, ...chromeArgs],
  });

  const results = [];
  let diagDone = false;
  try {
    for (const sc of SCENARIOS) {
      if (ONLY !== "all" && sc.name !== ONLY && sc.group !== ONLY) continue;
      const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => console.log(`[fps] pageerror: ${e.message}`));
      await page.goto(`${BASE}/${sc.query}`, { waitUntil: "load", timeout: 60000 });
      await page.waitForFunction(() => !!window.__mc, null, { timeout: 30000 });
      await page.evaluate((hw) => {
        window.__mc.setAutoRes(false);
        window.__mc.setHwScale(hw);
      }, HWSCALE);
      for (const step of sc.steps ?? []) await page.evaluate(step);

      await sleep(WARMUP);
      const first = !diagDone;
      if (flag("diag") && first) await printDiag(page);
      if (flag("profile") && first) await printProfile(page, Number(opt("profile-ms", 3000)));
      diagDone = true;
      const r = await page.evaluate(sampleInPage, { ms: SAMPLE });
      r.name = sc.name;
      results.push(r);
      console.log(
        `[fps] ${sc.name.padEnd(18)} avg ${r.fps.toFixed(1).padStart(6)} fps | ` +
          `p1 ${r.fpsP1.toFixed(1).padStart(5)} | frame ${r.frameMs.toFixed(2).padStart(6)} ms ` +
          `(cpu ${r.cpuMs.toFixed(2)}) | meshes ${String(r.activeMeshes).padStart(6)} | ` +
          `draws ${String(r.drawCalls).padStart(4)} | water ${r.water}`,
      );
      if (SHOT_DIR) {
        const file = path.resolve(SHOT_DIR, `${sc.name}.png`);
        await page.screenshot({ path: file });
        console.log(`[fps] shot -> ${file}`);
      }
      if (flag("edit") && sc.edit) {
        const e = await page.evaluate(editProbe, { count: 25 });
        if (e.error) console.log(`[edit] ${e.error}`);
        else {
          const st = (arr) => {
            const s = [...arr].sort((a, b) => a - b);
            return {
              avg: arr.reduce((a, b) => a + b, 0) / arr.length,
              p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
              max: s[s.length - 1],
            };
          };
          const b = st(e.breakMs), pl = st(e.placeMs);
          console.log(
            `[edit] break avg ${b.avg.toFixed(2)}ms p95 ${b.p95.toFixed(2)}ms max ${b.max.toFixed(2)}ms | ` +
              `place avg ${pl.avg.toFixed(2)}ms p95 ${pl.p95.toFixed(2)}ms max ${pl.max.toFixed(2)}ms | ` +
              `restored=${e.restored} block=${JSON.stringify(e.block)}`,
          );
          const after = await page.evaluate(sampleInPage, { ms: 3000 });
          console.log(`[edit] fps after 25x break/place: ${after.fps.toFixed(1)} (cpu ${after.cpuMs.toFixed(2)}ms)`);
          if (SHOT_DIR) {
            const file = path.resolve(SHOT_DIR, "after-edit.png");
            await page.screenshot({ path: file });
            console.log(`[fps] shot -> ${file}`);
          }
        }
      }
      if (flag("burst") && sc.edit) {
        if (flag("profile")) {
          // 编辑压力下的 profile：看几何构建(可搬进 worker) vs 顶点上传(必须在主线程)
          const st = await page.evaluate(startBurst, { perFrame: 5 });
          if (st.error) console.log(`[burst] ${st.error}`);
          else {
            await sleep(600);
            await printProfile(page, Number(opt("profile-ms", 2500)));
            await page.evaluate(() => { window.__burstStop = true; });
            await sleep(300);
          }
        }
        for (const perFrame of [1, 5]) {
          const b = await page.evaluate(burstProbe, { perFrame, frames: 120 });
          if (b.error) { console.log(`[burst] ${b.error}`); break; }
          const warm = b.cost.slice(20);   // 丢掉 JIT/GC 预热帧，只统计稳态
          const s = [...warm].sort((x, y) => x - y);
          const avg = warm.reduce((x, y) => x + y, 0) / warm.length;
          console.log(
            `[burst] ${perFrame} edit(s)/frame (${perFrame * 2} chunk rebuilds): ` +
              `cost avg ${avg.toFixed(1)}ms p95 ${s[Math.floor(s.length * 0.95)].toFixed(1)}ms max ${s[s.length - 1].toFixed(1)}ms | ` +
              `frame ${(1000 / b.fps).toFixed(1)}ms → ${b.fps.toFixed(1)} fps | restored=${b.restored}`,
          );
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    devServer?.kill();
  }

  // Summary: water shader on/off delta
  const water = results.filter((r) => r.name.startsWith("water"));
  if (water.length > 1 && water[0].fps > 0) {
    const base = water[0];
    console.log("\n[fps] water comparison (baseline = shader waves):");
    for (const r of water) {
      const gain = ((r.fps - base.fps) / base.fps) * 100;
      console.log(`  ${r.name.padEnd(12)} ${r.fps.toFixed(1)} fps  ${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%`);
    }
  }
  if (flag("json")) console.log("\n{json}\n" + JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("[fps] failed:", e);
  process.exit(1);
});
