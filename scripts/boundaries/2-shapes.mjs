// Step 2 of the boundary build: download each city's real boundary from OpenStreetMap (Overpass API).
//  a) per country, list OSM boundaries and match them to our cities by Wikidata item or by name
//  b) download the matches' shapes, join their ways into rings, simplify
//  c) keep every match that really contains the city's point (step 3 chooses)
// Output: .cache/boundaries/shapes/XX.json  { cities: { geonamesId: [{ rel, level, byQ }] }, shapes: { rel: area } }
// Safe to re-run: finished countries are skipped. Limit to countries: node 2-shapes.mjs BD US [--server=1]
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { inArea } from "../../src/geo.js";
import { simplify } from "./simplify.mjs";

const CACHE = ".cache/boundaries";
const UA = "vicinity-map-build/0.1 (https://vicinitycity.net)";
// Two public Overpass servers; run one process per server with --server=0 / --server=1 to go twice as fast.
const SERVERS = ["https://overpass-api.de/api", "https://maps.mail.ru/osm/tools/overpass/api"];
const server = Number(process.argv.find((a) => a.startsWith("--server="))?.split("=")[1] ?? 0);
const ENDPOINT = `${SERVERS[server]}/interpreter`;
const TOLERANCE = 0.0004; // degrees (≈ 45 m): simplification
mkdirSync(`${CACHE}/shapes`, { recursive: true });

const data = JSON.parse(readFileSync("public/data/cities.json", "utf8"));
const links = JSON.parse(readFileSync(`${CACHE}/links.json`, "utf8"));
const only = process.argv.slice(2).filter((a) => !a.startsWith("--")).map((s) => s.toUpperCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** overpass-api.de says when the next query slot opens; wait for it instead of getting refused. */
async function waitForSlot() {
  if (server !== 0) return;
  for (let i = 0; i < 30; i++) {
    const text = await fetch(`${SERVERS[0]}/status`, { headers: { "User-Agent": UA } }).then((r) => r.text()).catch(() => "");
    if (/\d+ slots? available now/.test(text) && !/^0 slots/m.test(text)) return;
    const secs = Math.min(...[...text.matchAll(/in (\d+) seconds/g)].map((m) => Number(m[1])), 60);
    await sleep((Number.isFinite(secs) ? secs + 1 : 10) * 1000);
  }
}

async function overpass(query) {
  for (let attempt = 1; attempt <= 8; attempt++) {
    await waitForSlot();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ data: query }),
    }).catch(() => null);
    if (res?.ok) { try { return await res.text(); } catch { /* connection dropped mid-answer: retry */ } }
    const wait = res?.status === 429 ? 30_000 : 10_000 * attempt;
    console.log(`  overpass ${res?.status ?? "network error"}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  throw new Error("overpass keeps failing");
}

/**
 * Every OSM boundary in a country that could be a city: admin levels 4–9 (level 4 covers city-states
 * like Mexico City, Berlin, Beijing; 10+ are neighbourhoods), plus place areas.
 * Falls back to the box around the country's cities when OSM has no area for the country code.
 * Big countries (US, India, China…) are asked box by box (3° tiles around their cities): a query
 * over the whole country times out on the public servers.
 */
async function candidatesIn(cc, cities) {
  const all = `rel(area.c)["boundary"="administrative"]["admin_level"~"^[2-9]$"]; rel(area.c)["place"~"^(city|town|municipality)$"];`;
  const cols = `[out:csv(::id,admin_level,wikidata,name,"name:en","int_name","official_name","alt_name";false;"\\t")][timeout:900]`;
  let csv = "";
  if (cities.length > 150) {
    const T = 3, tiles = new Set(cities.map((c) => `${Math.floor(c.lat / T) * T},${Math.floor(c.lon / T) * T}`));
    let n = 0;
    for (const t of tiles) {
      const [s, w] = t.split(",").map(Number);
      csv += (await overpass(`${cols};(${all.replaceAll("(area.c)", `(${s},${w},${s + T},${w + T})`)});out;`)) + "\n";
      if (++n % 10 === 0) console.log(`  ${cc}: ${n}/${tiles.size} map tiles searched`);
    }
  } else csv = await overpass(`${cols};area["ISO3166-1:alpha2"="${cc}"]["admin_level"="2"]->.c;(${all});out;`);
  if (csv.trim().split("\n").length < 2) {
    const lats = cities.map((c) => c.lat), lons = cities.map((c) => c.lon);
    const box = `${Math.min(...lats) - 0.5},${Math.min(...lons) - 0.5},${Math.max(...lats) + 0.5},${Math.max(...lons) + 0.5}`;
    csv = await overpass(`${cols};(${all.replaceAll("(area.c)", `(${box})`)});out;`);
  }
  const rows = new Map(); // a boundary crossing two tiles comes back twice
  for (const line of csv.split("\n").filter(Boolean)) {
    const [id, level, wikidata, ...names] = line.split("\t");
    rows.set(id, { id, level: Number(level) || 8, wikidata: (wikidata || "").split(";").map((s) => s.trim()).filter(Boolean), names: nameKeys(names) });
  }
  return [...rows.values()];
}

// ---- name matching -----------------------------------------------------------------------
// Words that don't change which place it is: "Dhaka Metropolitan", "Chittagong City", "Ville de Paris", "大阪市"
// multi-word phrases come first, so "City of Johannesburg" loses "city of" and not just "city"
const GENERIC = /\b(city of|town of|municipality of|municipio de|ville de|ville d|comune di|commune de|commune d|cidade de|ciudad de|city|municipality|municipal|municipio|metropolitan|metropolis|corporation|town|urban|stadt|gemeente|shi|si|gun)\b|[市]$/giu;
const norm = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(GENERIC, " ").replace(/[^\p{L}\p{N}]+/gu, "");
/** All the ways a boundary's names can be written: bilingual names ("Bruxelles - Brussel") are split too. */
function nameKeys(names) {
  const keys = new Set();
  for (const n of names.filter(Boolean)) for (const part of [n, ...n.split(/\s+[-–\/]\s+|;|\//)]) { const k = norm(part); if (k) keys.add(k); }
  return keys;
}

// ---- joining ways into rings -------------------------------------------------------------
const key = ([x, y]) => `${x},${y}`;
function joinRings(ways) {
  const rings = [];
  const open = ways.filter((w) => w.length >= 2).map((w) => w.slice());
  while (open.length) {
    let ring = open.pop();
    for (let guard = 0; key(ring[0]) !== key(ring[ring.length - 1]) && guard < 100_000; guard++) {
      const end = key(ring[ring.length - 1]);
      const i = open.findIndex((w) => key(w[0]) === end || key(w[w.length - 1]) === end);
      if (i < 0) break; // unclosed: dropped below
      const w = open.splice(i, 1)[0];
      ring = ring.concat((key(w[0]) === end ? w : w.reverse()).slice(1));
    }
    if (ring.length >= 4 && key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2; };

/** Overpass "out geom" relation → area [[outer, ...holes], ...] */
function toArea(rel) {
  const way = (m) => m.geometry.map((p) => [p.lon, p.lat]);
  const members = rel.members.filter((m) => m.type === "way" && m.geometry);
  const outers = joinRings(members.filter((m) => m.role !== "inner").map(way)).map((r) => simplify(r, TOLERANCE));
  const inners = joinRings(members.filter((m) => m.role === "inner").map(way)).map((r) => simplify(r, TOLERANCE));
  const polys = outers.filter((r) => Math.abs(ringArea(r)) > 1e-7).map((r) => [r]);
  for (const h of inners) {
    const owner = polys.find(([o]) => inArea(h[0][0], h[0][1], [[o]]));
    if (owner) owner.push(h);
  }
  return polys;
}

// ---- main -------------------------------------------------------------------------------
let countries = Object.keys(data.byCountry).filter((cc) => !only.length || only.includes(cc));
if (process.argv.includes("--reverse")) countries = countries.reverse(); // a second worker can start from the other end
for (const cc of countries) {
  const out = `${CACHE}/shapes/${cc}.json`, lock = `${out}.lock`;
  if (existsSync(out)) continue;
  // another worker is on this country right now (locks older than 30 min are from a stopped run)
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs < 30 * 60_000) continue;
  writeFileSync(lock, String(process.pid));
  try { await country(cc, out); }
  catch (e) { console.log(`${cc}: skipped (${e.message}), run this script again later to retry it`); }
  rmSync(lock, { force: true });
  await sleep(2000);
}

async function country(cc, out) {
  const cities = data.byCountry[cc].map(([id, name, , lat, lon, pop]) => ({ id: String(id), name, lat, lon, pop }));

  // a) match cities → candidate boundaries: same Wikidata item, or same name.
  //    Country-level (2–3) boundaries only count for city-states (a country with 1–2 listed cities).
  const rows = await candidatesIn(cc, cities);
  const minLevel = cities.length <= 2 ? 2 : 4;
  const candidates = new Map();
  for (const c of cities) {
    const qs = new Set(links[c.id]?.q ?? []);
    const key = norm(c.name);
    const list = rows
      .filter((r) => r.level >= minLevel)
      .map((r) => ({ ...r, byQ: r.wikidata.some((q) => qs.has(q)), byName: r.names.has(key) }))
      .filter((r) => r.byQ || r.byName);
    if (list.length) candidates.set(c.id, list);
  }

  // b) download shapes, 40 relations per request (5 at a time if a big batch keeps failing)
  const all = [...new Set([...candidates.values()].flat().map((r) => r.id))];
  const shapes = new Map();
  const fetchShapes = async (ids) => {
    const json = JSON.parse(await overpass(`[out:json][timeout:900];rel(id:${ids.join(",")});out geom;`));
    for (const el of json.elements) if (el.type === "relation") shapes.set(String(el.id), toArea(el));
  };
  for (let i = 0; i < all.length; i += 40) {
    const batch = all.slice(i, i + 40);
    try { await fetchShapes(batch); } catch { for (let j = 0; j < batch.length; j += 5) await fetchShapes(batch.slice(j, j + 5)); }
    await sleep(1000);
  }

  // c) only boundaries that actually contain the city's point count (guards against same-name places
  //    elsewhere). All of them are kept; step 3 picks one, so the choice can change without downloading again.
  const matches = {}, kept = {};
  for (const c of cities) {
    const ok = (candidates.get(c.id) ?? []).filter((r) => shapes.get(r.id)?.length && inArea(c.lon, c.lat, shapes.get(r.id)));
    if (!ok.length) continue;
    matches[c.id] = ok.map((r) => ({ rel: r.id, level: r.level, byQ: r.byQ }));
    for (const r of ok) kept[r.id] = shapes.get(r.id);
  }
  writeFileSync(out, JSON.stringify({ cities: matches, shapes: kept }));
  console.log(`${cc}: ${Object.keys(matches).length}/${cities.length} cities have a real boundary (${all.length} relations downloaded)`);
}
