// Step 1 of the boundary build: find each city's Wikidata item, and its OSM relation if Wikidata knows it.
// GeoNames id → Wikidata item (P1566), + OSM relation id (P402) when present.
// Step 2 then looks for OSM boundaries tagged with those Wikidata items (OSM tags them far more often).
// Output: .cache/boundaries/links.json  { geonamesId: { q: ["Q60"], osm: ["175905"] } }
// Safe to re-run: finished batches are kept and skipped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = ".cache/boundaries";
const OUT = `${CACHE}/links.json`;
const DONE = `${CACHE}/links-done.json`;
const BATCH = 400;
const UA = "vicinity-map-build/0.1 (https://vicinitycity.net)";
mkdirSync(CACHE, { recursive: true });

const data = JSON.parse(readFileSync("public/data/cities.json", "utf8"));
const ids = Object.values(data.byCountry).flat().map((r) => String(r[0]));
const links = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const done = new Set(existsSync(DONE) ? JSON.parse(readFileSync(DONE, "utf8")) : []);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const add = (list, v) => { if (v && !list.includes(v)) list.push(v); };

async function query(batch) {
  const values = batch.map((id) => `"${id}"`).join(" ");
  const q = `SELECT ?g ?i ?osm WHERE { VALUES ?g { ${values} } ?i wdt:P1566 ?g. OPTIONAL { ?i wdt:P402 ?osm } }`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "User-Agent": UA, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query: q }),
    }).catch(() => null);
    if (res?.ok) return (await res.json()).results.bindings;
    await sleep(5000 * attempt);
  }
  throw new Error("wikidata keeps failing");
}

for (let i = 0; i < ids.length; i += BATCH) {
  const key = String(i);
  if (done.has(key)) continue;
  for (const b of await query(ids.slice(i, i + BATCH))) {
    const e = (links[b.g.value] ||= { q: [], osm: [] });
    add(e.q, b.i.value.split("/").pop());
    add(e.osm, b.osm?.value);
  }
  done.add(key);
  writeFileSync(OUT, JSON.stringify(links));
  writeFileSync(DONE, JSON.stringify([...done]));
  console.log(`${Math.min(i + BATCH, ids.length)}/${ids.length} checked, ${Object.keys(links).length} found on Wikidata`);
  await sleep(500);
}
const withOsm = Object.values(links).filter((e) => e.osm.length).length;
console.log(`done: ${Object.keys(links).length} of ${ids.length} on Wikidata, ${withOsm} with a direct OSM link`);
