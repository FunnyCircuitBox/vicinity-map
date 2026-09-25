/**
 * Small geometry helpers for city boundaries (used by the Worker and by the build scripts).
 * A polygon is [outerRing, ...holes]; a ring is [[lon, lat], ...]; a city area is a list of polygons.
 */

/** Is the point inside the ring? (ray casting; lon/lat treated as flat, fine at city scale) */
export function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Is the point inside the area (inside an outer ring and not in one of its holes)? */
export function inArea(lon, lat, area) {
  for (const [outer, ...holes] of area) {
    if (inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h))) return true;
  }
  return false;
}

/**
 * City boundaries are stored as integers: degrees × 1e4 (≈ 11 m), each ring delta-encoded
 * as a flat list [x0, y0, dx1, dy1, ...]. This keeps the files small.
 */
export const Q = 1e4;
export function decodeRing(flat) {
  const ring = new Array(flat.length / 2);
  let x = 0, y = 0;
  for (let i = 0; i < flat.length; i += 2) { x += flat[i]; y += flat[i + 1]; ring[i / 2] = [x / Q, y / Q]; }
  return ring;
}
export function encodeRing(ring) {
  const out = [];
  let px = 0, py = 0;
  for (const [lon, lat] of ring) {
    const x = Math.round(lon * Q), y = Math.round(lat * Q);
    out.push(x - px, y - py);
    px = x; py = y;
  }
  return out;
}
export const decodeArea = (enc) => enc.map((poly) => poly.map(decodeRing));
export const encodeArea = (area) => area.map((poly) => poly.map(encodeRing));

/**
 * Country boundary files (public/data/bounds/XX.txt), one line per listed city:
 *   "<id>\tr\t<minLon,minLat,maxLon,maxLat>\t<encoded area JSON>"  real (OpenStreetMap) boundary
 *   "<id>\tn\t<box>\t<encoded area JSON>"                          leftover land nearest the city
 *   "<id>\tp\t<parent id>"                                          part of another city (a neighbourhood)
 *   "<id>\to\t-"                                                    outside every community (empty land)
 * Only the lines that matter are parsed, so checks stay cheap in the Worker.
 */
function parseLine(line) {
  const [id, kind, a, json] = line.split("\t");
  if (kind === "p") return { id, kind, parent: a };
  if (kind === "o") return { id, kind }; // outside every community (empty land)
  return { id, kind, box: a.split(",").map(Number), json };
}

/** One city's line: { id, kind, parent } or { id, kind, box, area }. null if the city has no line. */
export function findCityArea(text, id) {
  const at = ("\n" + text).indexOf(`\n${id}\t`);
  if (at < 0) return null;
  const end = text.indexOf("\n", at);
  const row = parseLine(text.slice(at, end < 0 ? undefined : end));
  if (row.json) { row.area = decodeArea(JSON.parse(row.json)); delete row.json; }
  return row;
}

/** Which listed city's area contains the point? Returns its id, or null. Boxes are checked before shapes. */
export function cityAt(text, lon, lat) {
  for (const line of text.split("\n")) {
    if (!line) continue;
    const row = parseLine(line);
    if (row.kind === "p" || row.kind === "o") continue;
    const [a, b, c, d] = row.box;
    if (lon < a || lon > c || lat < b || lat > d) continue;
    if (inArea(lon, lat, decodeArea(JSON.parse(row.json)))) return row.id;
  }
  return null;
}
