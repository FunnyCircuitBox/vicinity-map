// Finding (and removing) overlaps between city areas. Used by 3-build.mjs and check-overlaps.mjs.
// An area is [[outer, ...holes], ...] in [lon, lat]; each item is { id, area, box, kind }.
import pc from "polygon-clipping";

/** Area in km² (small-area approximation, fine at city scale). */
export function kmArea(area) {
  let s = 0;
  for (const [outer, ...holes] of area) for (const [i, r] of [outer, ...holes].entries()) {
    let t = 0;
    for (let k = 0, j = r.length - 1; k < r.length; j = k++) t += (r[j][0] - r[k][0]) * (r[j][1] + r[k][1]);
    s += (i === 0 ? 1 : -1) * Math.abs(t / 2) * 111.32 * Math.cos((r[0][1] * Math.PI) / 180) * 110.57;
  }
  return s;
}
export const bboxOf = (area) => {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const poly of area) for (const [x, y] of poly[0]) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
};
const hits = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];

/**
 * polygon-clipping can fail on long, exactly collinear shared borders ("Unable to complete output
 * ring"). Shifting the second shape by a hair (0.1 mm – 1 mm) gets past it without changing anything
 * that matters; the build snaps everything back to the grid afterwards. Returns null if all tries fail.
 */
const shift = (g, e) => g.map((p) => p.map((r) => r.map(([x, y]) => [x + e, y + e * 0.7])));
export function robust(op, a, b) {
  for (const e of [0, 1e-9, -1e-9, 1e-8]) {
    try { return pc[op](a, e ? shift(b, e) : b); } catch { /* next */ }
  }
  return null;
}

/**
 * Rounding can make a shape's outline cross itself (Ganshui, China), and then no cut against it works.
 * Such a shape is rebuilt as a clean union of itself (shifted by a hair if needed); fine shapes are
 * returned unchanged, the same object.
 */
export function repair(area) {
  try { pc.union(area); return area; } catch { /* broken: rebuild it */ }
  for (const e of [1e-9, -1e-9, 1e-8]) { try { return pc.union(shift(area, e)); } catch { /* next */ } }
  return area;
}

export const pairKey = (a, b) => (a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`);

/** Exact shared area in km² (0 if none; null if the geometry library couldn't compute it). */
export function sharedKm2(a, b) {
  const x = robust("intersection", a, b);
  return x === null ? null : x.length ? kmArea(x) : 0;
}

/**
 * Every pair of items whose areas share more than minKm2. Uses a 1° grid so only neighbours are compared.
 * Returns [{ a, b, km2 }] sorted biggest first.
 */
export function findOverlaps(items, minKm2 = 0.001) {
  const grid = new Map();
  for (const it of items) {
    it.box ||= bboxOf(it.area);
    for (let x = Math.floor(it.box[0]); x <= Math.floor(it.box[2]); x++)
      for (let y = Math.floor(it.box[1]); y <= Math.floor(it.box[3]); y++) {
        const k = `${x},${y}`;
        (grid.get(k) ?? grid.set(k, []).get(k)).push(it);
      }
  }
  const seen = new Set(), out = [];
  for (const cell of grid.values()) {
    for (let i = 0; i < cell.length; i++) for (let j = i + 1; j < cell.length; j++) {
      const a = cell[i], b = cell[j];
      const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!hits(a.box, b.box)) continue;
      const km2 = sharedKm2(a.area, b.area);
      if (km2 === null || km2 > minKm2) out.push({ a, b, km2 });
    }
  }
  return out.sort((x, y) => (y.km2 ?? Infinity) - (x.km2 ?? Infinity));
}

/**
 * Weld a shared border: every corner of one area that lies within `tol` degrees (≈ 10 cm) of an edge of
 * the other, without being one of its corners, is inserted into that edge (both ways). Two versions of the
 * same long border that start at slightly different corners otherwise leave a hair-thin sliver
 * (Tübingen × Sindelfingen: 34 km long, 1 cm wide).
 */
export function weld(a, b, tol = 1e-6) {
  let inserted = 0;
  const into = (target, source) => {
    const pts = source.flat(2);
    for (const poly of target) for (const ring of poly) {
      for (let i = 1; i < ring.length; i++) {
        const [x1, y1] = ring[i - 1], [x2, y2] = ring[i], dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
        if (!l) continue;
        // corners of the other area sitting on this edge, in order along it
        const on = [];
        for (const [px, py] of pts) {
          const t = ((px - x1) * dx + (py - y1) * dy) / l;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          if (Math.hypot(px - x1 - t * dx, py - y1 - t * dy) <= tol) on.push([t, px, py]);
        }
        if (!on.length) continue;
        on.sort((p, q) => p[0] - q[0]);
        const add = on.map(([, px, py]) => [px, py]).filter((p, k, arr) => !k || p[0] !== arr[k - 1][0] || p[1] !== arr[k - 1][1]);
        ring.splice(i, 0, ...add);
        i += add.length;
        inserted += add.length;
      }
    }
  };
  into(b.area, a.area);
  into(a.area, b.area);
  return inserted;
}

/**
 * Remove overlaps: the shared part stays with one city and is cut from the other.
 * An official boundary beats a nearest-land area; between two of the same kind the smaller area keeps it.
 * Returns how many overlaps were removed and which couldn't be (geometry errors).
 */
export function removeOverlaps(items, minKm2 = 0.001, flip = new Set()) {
  let removed = 0; const failed = [];
  for (let pass = 0; pass < 3; pass++) {
    const found = findOverlaps(items.filter((it) => it.area.length), minKm2);
    if (!found.length) break;
    for (const { a, b } of found) {
      let [keep, lose] = a.kind !== b.kind ? (a.kind === "r" ? [a, b] : [b, a]) : kmArea(a.area) <= kmArea(b.area) ? [a, b] : [b, a];
      // a pair that keeps coming back after rounding: cut the shared bit from the other side instead
      if (flip.has(pairKey(a, b))) [keep, lose] = [lose, keep];
      let rest = robust("difference", lose.area, keep.area);
      // the geometry library can fail one way and not the other (Zhuji − Hangzhou fails,
      // Hangzhou − Zhuji works): then cut the shared bit from the other side
      if (!rest) { [keep, lose] = [lose, keep]; rest = robust("difference", lose.area, keep.area); }
      if (!rest) { failed.push(`${lose.id} vs ${keep.id}`); continue; }
      lose.area = rest.filter((poly) => kmArea([poly]) > 0.0001);
      lose.box = lose.area.length ? bboxOf(lose.area) : [0, 0, 0, 0];
      removed++;
    }
  }
  return { removed, failed };
}
