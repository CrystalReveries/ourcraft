/* 方块几何（纯函数，无 Babylon 场景依赖，便于单元测试） */

export interface BoxTiles { top: number; side: number; bottom: number; }
/** 六面各自独立的 tile（用于生物头部：只让正脸贴图出现在正面） */
export interface BoxTiles6 { top: number; bottom: number; front: number; back: number; left: number; right: number; }
export interface UVRect { u0: number; u1: number; v0: number; v1: number; }
export interface BoxGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;

// 通用 tile -> UV 矩形（canvas 从上到下 -> v 从 1 到 0）
export function tileUVIn(t: number, cols: number, rows: number): UVRect {
  const col = t % cols, row = Math.floor(t / cols);
  return {
    u0: col / cols,
    u1: (col + 1) / cols,
    v0: 1 - (row + 1) / rows,
    v1: 1 - row / rows,
  };
}

export function tileUV(t: number): UVRect {
  return tileUVIn(t, ATLAS_COLS, ATLAS_ROWS);
}

export type FaceDef = {
  n: [number, number, number];   // 法线
  t: [number, number, number];   // 切线 (u+)
  b: [number, number, number];   // 副切线 (v+)
  tile: number;
};

export function faceDefs(tiles: BoxTiles): FaceDef[] {
  return [
    { n: [0, 1, 0], t: [1, 0, 0], b: [0, 0, -1], tile: tiles.top },
    { n: [0, -1, 0], t: [1, 0, 0], b: [0, 0, 1], tile: tiles.bottom },
    { n: [0, 0, 1], t: [1, 0, 0], b: [0, 1, 0], tile: tiles.side },
    { n: [0, 0, -1], t: [-1, 0, 0], b: [0, 1, 0], tile: tiles.side },
    { n: [1, 0, 0], t: [0, 0, -1], b: [0, 1, 0], tile: tiles.side },
    { n: [-1, 0, 0], t: [0, 0, 1], b: [0, 1, 0], tile: tiles.side },
  ];
}

/** 六面各自使用不同 tile 的面定义（正脸只在 +Z 面） */
export function faceDefs6(tiles: BoxTiles6): FaceDef[] {
  return [
    { n: [0, 1, 0], t: [1, 0, 0], b: [0, 0, -1], tile: tiles.top },
    { n: [0, -1, 0], t: [1, 0, 0], b: [0, 0, 1], tile: tiles.bottom },
    { n: [0, 0, 1], t: [1, 0, 0], b: [0, 1, 0], tile: tiles.front },
    { n: [0, 0, -1], t: [-1, 0, 0], b: [0, 1, 0], tile: tiles.back },
    { n: [1, 0, 0], t: [0, 0, -1], b: [0, 1, 0], tile: tiles.right },
    { n: [-1, 0, 0], t: [0, 0, 1], b: [0, 1, 0], tile: tiles.left },
  ];
}

function buildFromFaces(defs: FaceDef[], cols: number, rows: number): BoxGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const f of defs) {
    const r = tileUVIn(f.tile, cols, rows);
    const base = positions.length / 3;
    const c = [f.n[0] / 2, f.n[1] / 2, f.n[2] / 2];
    const corners: Array<[number, number, number]> = [
      [c[0] - f.t[0] / 2 - f.b[0] / 2, c[1] - f.t[1] / 2 - f.b[1] / 2, c[2] - f.t[2] / 2 - f.b[2] / 2],
      [c[0] + f.t[0] / 2 - f.b[0] / 2, c[1] + f.t[1] / 2 - f.b[1] / 2, c[2] + f.t[2] / 2 - f.b[2] / 2],
      [c[0] + f.t[0] / 2 + f.b[0] / 2, c[1] + f.t[1] / 2 + f.b[1] / 2, c[2] + f.t[2] / 2 + f.b[2] / 2],
      [c[0] - f.t[0] / 2 + f.b[0] / 2, c[1] - f.t[1] / 2 + f.b[1] / 2, c[2] - f.t[2] / 2 + f.b[2] / 2],
    ];
    for (const p of corners) positions.push(...p);
    for (const uv of [[r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]] as Array<[number, number]>)
      uvs.push(...uv);
    for (let k = 0; k < 4; k++) normals.push(f.n[0], f.n[1], f.n[2]);
    // 顺时针绕序（相对外法线），与 Babylon 前向面约定一致
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  return { positions, normals, uvs, indices };
}

/**
 * 生成立方体几何（单位立方体，中心在原点）。
 *
 * 绕序约定：Babylon(左手系) 的前向面是「(p1-p0)×(p2-p0) 与法线反向」的三角形，
 * 因此索引按顺时针（相对外法线）排列，否则外表面会被背面剔除，
 * 方块看起来像只有内壁的「开口盒子」。
 */
export function buildBoxGeometry(tiles: BoxTiles): BoxGeometry {
  return buildFromFaces(faceDefs(tiles), ATLAS_COLS, ATLAS_ROWS);
}

/** 可累积的几何缓冲（区块合并网格：多个方块的面写入同一组数组） */
export interface GeoBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

/**
 * 把立方体的**一个面**追加进缓冲，方块占据 `[x,x+1]×[y,y+1]×[z,z+1]`。
 *
 * 顶点布局 / UV / 绕序与 `buildBoxGeometry` 完全一致（只是把面平移到方块位置），
 * 因此区块合并网格与旧的逐方块实例在视觉上等价。可见性由调用方按面判断。
 */
export function appendBoxFace(buf: GeoBuffers, f: FaceDef, x: number, y: number, z: number): void {
  const r = tileUV(f.tile);
  const base = buf.positions.length / 3;
  const cx = x + 0.5 + f.n[0] * 0.5;
  const cy = y + 0.5 + f.n[1] * 0.5;
  const cz = z + 0.5 + f.n[2] * 0.5;
  const [t0, t1, t2] = f.t;
  const [b0, b1, b2] = f.b;
  buf.positions.push(
    cx - t0 / 2 - b0 / 2, cy - t1 / 2 - b1 / 2, cz - t2 / 2 - b2 / 2,
    cx + t0 / 2 - b0 / 2, cy + t1 / 2 - b1 / 2, cz + t2 / 2 - b2 / 2,
    cx + t0 / 2 + b0 / 2, cy + t1 / 2 + b1 / 2, cz + t2 / 2 + b2 / 2,
    cx - t0 / 2 + b0 / 2, cy - t1 / 2 + b1 / 2, cz - t2 / 2 + b2 / 2,
  );
  buf.uvs.push(r.u0, r.v0, r.u1, r.v0, r.u1, r.v1, r.u0, r.v1);
  for (let k = 0; k < 4; k++) buf.normals.push(f.n[0], f.n[1], f.n[2]);
  buf.indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
}

/** 六面各自贴不同 tile 的立方体（cols/rows 为贴图网格尺寸） */
export function buildBoxGeometry6(tiles: BoxTiles6, cols = ATLAS_COLS, rows = ATLAS_ROWS): BoxGeometry {
  return buildFromFaces(faceDefs6(tiles), cols, rows);
}

/**
 * 十字植物直立四边形（y=0 底部 / y=1 顶部，边长 2*size）。
 *
 * UV 约定与方块一致：**底部顶点取较小的 v（tile 的 v0）**。
 * 反过来（底部取 v1）会让贴图上下颠倒 —— 草叶的根在天上、花冠埋进土里。
 */
export function buildPlantQuadGeometry(tile: number, cols: number, rows: number, size = 0.5): BoxGeometry {
  const r = tileUVIn(tile, cols, rows);
  const s = size;
  return {
    positions: [-s, 0, -s, s, 0, s, s, 1, s, -s, 1, -s],
    normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
    uvs: [r.u0, r.v0, r.u1, r.v0, r.u1, r.v1, r.u0, r.v1],
    indices: [0, 1, 2, 0, 2, 3],
  };
}
