// Step 1 of the boundary build: find each city's Wikidata item, and its OSM relation if Wikidata knows it.
// GeoNames id → Wikidata item (P1566), + OSM relation id (P402) when present.
// Step 2 then looks for OSM boundaries tagged with those Wikidata items (OSM tags them far more often).
// Output: .cache/boundaries/links.json  { geonamesId: { q: ["Q60"], osm: ["175905"] } }
// Safe to re-run: cities already checked are skipped (so the city list can grow).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = ".cache/boundaries";
const OUT = `${CACHE}/links.json`;
const CHECKED = `${CACHE}/links-checked.json`;
const BATCH = 800;
const UA = "vicinity-map-build/0.1 (https://vicinitycity.net)";
mkdirSync(CACHE, { recursive: true });

// the city list to work on (CITIES=path to use another list, e.g. while building a bigger one)
const data = JSON.parse(readFileSync(process.env.CITIES || "public/data/cities.json", "utf8"));
const ids = Object.values(data.byCountry).flat().map((r) => String(r[0]));
const links = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const checked = new Set(existsSync(CHECKED) ? JSON.parse(readFileSync(CHECKED, "utf8")) : []);
// runs from before this file existed checked every city then on the list
if (!checked.size && existsSync(`${CACHE}/links-done.json`) && existsSync(".cache/cities-13k.json"))
  for (const r of Object.values(JSON.parse(readFileSync(".cache/cities-13k.json", "utf8")).byCountry).flat()) checked.add(String(r[0]));
const todo = ids.filter((id) => !checked.has(id));
console.log(`${todo.length} of ${ids.length} cities still to look up`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const add = (list, v) => { if (v && !list.includes(v)) list.push(v); };

async function query(batch) {
  const values = batch.map((id) => `"${id}"`).join(" ");
  const q = `SELECT ?g ?i ?osm WHERE { VALUES ?g { ${values} } ?i wdt:P1566 ?g. OPTIONAL { ?i wdt:P402 ?osm } }`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch("https://query.wikidata.org/sparql", {
        method: "POST",
        headers: { "User-Agent": UA, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: q }),
      });
      if (res.ok) return (await res.json()).results.bindings;
    } catch { /* retry */ }
    await sleep(5000 * attempt);
  }
  throw new Error("wikidata keeps failing");
}

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  for (const b of await query(batch)) {
    const e = (links[b.g.value] ||= { q: [], osm: [] });
    add(e.q, b.i.value.split("/").pop());
    add(e.osm, b.osm?.value);
  }
  for (const id of batch) checked.add(id);
  writeFileSync(OUT, JSON.stringify(links));
  writeFileSync(CHECKED, JSON.stringify([...checked]));
  console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length} checked, ${Object.keys(links).length} found on Wikidata`);
  await sleep(500);
}
const withOsm = Object.values(links).filter((e) => e.osm.length).length;
console.log(`done: ${Object.keys(links).length} of ${ids.length} on Wikidata, ${withOsm} with a direct OSM link`);
