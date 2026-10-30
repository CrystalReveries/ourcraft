/* 方块几何（纯函数，无 Babylon 场景依赖，便于单元测试） */

export interface BoxTiles { top: number; side: number; bottom: number; }
export interface UVRect { u0: number; u1: number; v0: number; v1: number; }
export interface BoxGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
}

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 4;

// tile 索引 -> 图集 UV 矩形（canvas 从上到下 -> v 从 1 到 0）
export function tileUV(t: number): UVRect {
  const col = t % ATLAS_COLS, row = Math.floor(t / ATLAS_COLS);
  return {
    u0: col / ATLAS_COLS,
    u1: (col + 1) / ATLAS_COLS,
    v0: 1 - (row + 1) / ATLAS_ROWS,
    v1: 1 - row / ATLAS_ROWS,
  };
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

/**
 * 生成立方体几何（单位立方体，中心在原点）。
 *
 * 绕序约定：Babylon(左手系) 的前向面是「(p1-p0)×(p2-p0) 与法线反向」的三角形，
 * 因此索引按顺时针（相对外法线）排列，否则外表面会被背面剔除，
 * 方块看起来像只有内壁的「开口盒子」。
 */
export function buildBoxGeometry(tiles: BoxTiles): BoxGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const f of faceDefs(tiles)) {
    const r = tileUV(f.tile);
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
