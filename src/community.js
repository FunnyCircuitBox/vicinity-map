/**
 * Which community is this spot in? Used once to set a person's home community (and for
 * check-ins and "add my town" requests). The location itself is never saved.
 *
 *   inside a community's area                → that community
 *   in empty land (outside every community)  → the three nearest communities to choose from
 */
import { countryBounds, countryCities, distanceKm } from "./cities.js";
import { cityAt } from "./geo.js";

/** The communities of a country: every city with an area line ("r" official, "n" nearest land). */
function communityIds(bounds) {
  const ids = new Set();
  for (const line of bounds.split("\n")) {
    const t1 = line.indexOf("\t");
    const kind = line.slice(t1 + 1, t1 + 2);
    if (t1 > 0 && (kind === "r" || kind === "n")) ids.add(line.slice(0, t1));
  }
  return ids;
}

/**
 * Locate a point inside a country. Returns
 *   { city: { id, name, country } }                  when the point is inside a community
 *   { city: null, nearby: [{ id, name, country, km }] } otherwise (up to three, nearest first)
 *   null when the country has no data
 */
export async function locate(env, cc, lon, lat) {
  const [listed, bounds] = await Promise.all([countryCities(env, cc), countryBounds(env, cc).catch(() => null)]);
  if (!listed) return null;
  const byId = new Map(listed.map((c) => [c.id, c]));
  const named = (c, km) => ({ id: c.id, name: c.name, country: cc, ...(km != null ? { km: Math.round(km * 10) / 10 } : {}) });
  if (bounds) {
    const id = cityAt(bounds, lon, lat);
    if (id && byId.has(id)) return { city: named(byId.get(id)) };
  }
  // empty land: the three nearest communities (without boundary data, the three nearest listed places)
  const ids = bounds ? communityIds(bounds) : null;
  const best = [];
  for (const c of listed) {
    if (ids && !ids.has(c.id)) continue;
    const d = distanceKm(lat, lon, c.lat, c.lon);
    if (best.length === 3 && d >= best[2][1]) continue;
    best.push([c, d]);
    best.sort((a, b) => a[1] - b[1]);
    if (best.length > 3) best.pop();
  }
  return { city: null, nearby: best.map(([c, d]) => named(c, d)) };
}

/** A listed community by id in a country: { id, name, country } or null. */
export async function communityById(env, cc, id) {
  const listed = await countryCities(env, cc);
  const c = listed && listed.find((x) => x.id === String(id));
  return c ? { id: c.id, name: c.name, country: cc } : null;
}
