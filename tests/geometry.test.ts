/* 方块几何单元测试: 绕序 / UV / 顶点结构
 * 运行: npm test  (npx tsx tests/geometry.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBoxGeometry, tileUV, faceDefs, ATLAS_COLS, ATLAS_ROWS } from "../src/geometry";

const EPS = 1e-6;
type V3 = [number, number, number];

function triCrossDotNormal(g: ReturnType<typeof buildBoxGeometry>, t: number): number {
  const [ia, ib, ic] = [g.indices[t], g.indices[t + 1], g.indices[t + 2]];
  const p = (i: number): V3 => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
  const [p0, p1, p2] = [p(ia), p(ib), p(ic)];
  const u: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const v: V3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const vn: V3 = [g.normals[ia * 3], g.normals[ia * 3 + 1], g.normals[ia * 3 + 2]];
  return n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2];
}

test("顶点/索引数量正确 (6面 x 4顶点 x 2三角)", () => {
  const g = buildBoxGeometry({ top: 0, side: 1, bottom: 2 });
  assert.equal(g.positions.length, 6 * 4 * 3);
  assert.equal(g.normals.length, 6 * 4 * 3);
  assert.equal(g.uvs.length, 6 * 4 * 2);
  assert.equal(g.indices.length, 6 * 2 * 3);
});

test("绕序与 Babylon 前向面约定一致: cross(p1-p0, p2-p0)·法线 < 0", () => {
  // Babylon 官方 CreateBox 的 12 个三角形全部满足 cross·normal < 0；
  // 若符号相反, 外表面会被背面剔除, 方块看起来像"开口盒子"。
  const g = buildBoxGeometry({ top: 0, side: 1, bottom: 2 });
  for (let t = 0; t < g.indices.length; t += 3) {
    const d = triCrossDotNormal(g, t);
    assert.ok(d < -EPS, `三角形 ${t / 3} 绕序错误: cross·normal = ${d}`);
  }
});

test("几何是闭合立方体: 每个顶点恰好位于 6 个面之一, 包围盒 [-0.5, 0.5]^3", () => {
  const g = buildBoxGeometry({ top: 0, side: 1, bottom: 2 });
  for (let i = 0; i < g.positions.length; i += 3) {
    const [x, y, z] = [g.positions[i], g.positions[i + 1], g.positions[i + 2]];
    const onSurface = [x, y, z].filter(v => Math.abs(Math.abs(v) - 0.5) < EPS).length;
    assert.ok(onSurface >= 1, `顶点 (${x},${y},${z}) 不在立方体表面`);
    assert.ok(Math.abs(x) <= 0.5 + EPS && Math.abs(y) <= 0.5 + EPS && Math.abs(z) <= 0.5 + EPS);
  }
});

test("顶面/侧面/底面采样到不同的 tile 区域", () => {
  const g = buildBoxGeometry({ top: 0, side: 1, bottom: 2 });
  const tiles = faceDefs({ top: 0, side: 1, bottom: 2 }).map(f => f.tile);
  assert.deepEqual(tiles.slice(0, 2), [0, 2]);      // 顶/底不同
  assert.ok(tiles.slice(2).every(t => t === 1));     // 四侧相同

  // 第 0 个面(顶) UV 中心应落在 tile0 内, 第 1 个面(底) 落在 tile2 内
  const uvCenter = (face: number): [number, number] => {
    let u = 0, v = 0;
    for (let k = 0; k < 4; k++) {
      u += g.uvs[(face * 4 + k) * 2];
      v += g.uvs[(face * 4 + k) * 2 + 1];
    }
    return [u / 4, v / 4];
  };
  const inside = (uv: [number, number], t: number): boolean => {
    const r = tileUV(t);
    return uv[0] > r.u0 && uv[0] < r.u1 && uv[1] > r.v0 && uv[1] < r.v1;
  };
  assert.ok(inside(uvCenter(0), 0), "顶面 UV 未落在草顶 tile");
  assert.ok(inside(uvCenter(1), 2), "底面 UV 未落在泥土 tile");
  assert.ok(inside(uvCenter(2), 1), "侧面 UV 未落在草侧 tile");
});

test("图集 UV 不越界且 tile 网格正确", () => {
  for (let t = 0; t < ATLAS_COLS * ATLAS_ROWS; t++) {
    const r = tileUV(t);
    assert.ok(r.u0 >= 0 && r.u1 <= 1 && r.v0 >= 0 && r.v1 <= 1);
    assert.ok(Math.abs(r.u1 - r.u0 - 1 / ATLAS_COLS) < EPS);
    assert.ok(Math.abs(r.v1 - r.v0 - 1 / ATLAS_ROWS) < EPS);
  }
});
