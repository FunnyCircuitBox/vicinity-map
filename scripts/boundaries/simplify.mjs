// Douglas-Peucker line simplification for closed rings (build scripts only).
export function simplify(ring, tol) {
  if (ring.length <= 5) return ring;
  const kx = Math.cos((ring[0][1] * Math.PI) / 180);
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = ring[a], [bx, by] = ring[b];
    const dx = (bx - ax) * kx, dy = by - ay, len = Math.hypot(dx, dy) || 1e-12;
    let best = 0, at = -1;
    for (let i = a + 1; i < b; i++) {
      const px = (ring[i][0] - ax) * kx, py = ring[i][1] - ay;
      const d = len > 1e-12 ? Math.abs(dx * py - dy * px) / len : Math.hypot(px, py);
      if (d > best) { best = d; at = i; }
    }
    if (best > tol) { keep[at] = 1; stack.push([a, at], [at, b]); }
  }
  // closed rings: make sure at least 4 points survive
  const out = ring.filter((_, i) => keep[i]);
  return out.length >= 4 ? out : ring.filter((_, i) => i % Math.ceil(ring.length / 4) === 0).concat([ring[0]]);
}

