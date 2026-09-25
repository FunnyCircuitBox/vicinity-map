// Step 1b of the boundary build: which listed places does Wikidata say another listed place is in?
// Brooklyn → New York City, Financial District → Manhattan → New York City, Carabanchel → Madrid;
// but Guarulhos is in São Paulo *state*, not São Paulo city. Step 3 uses this for "one coin per big city".
// GeoNames id → Wikidata item → "located in the administrative territorial entity" (P131, any depth)
// → those ancestors' GeoNames ids.
// Output: .cache/boundaries/located-in.json  { geonamesId: [ancestor geonamesId, ...] } (listed places only)
// Safe to re-run: cities already checked are skipped (so the city list can grow).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = ".cache/boundaries";
const OUT = `${CACHE}/located-in.json`;
const CHECKED = `${CACHE}/located-in-checked.json`;
const BATCH = 250;
const UA = "vicinity-map-build/0.1 (https://vicinitycity.net)";
mkdirSync(CACHE, { recursive: true });

// the city list to work on (CITIES=path to use another list, e.g. while building a bigger one)
const data = JSON.parse(readFileSync(process.env.CITIES || "public/data/cities.json", "utf8"));
const ids = Object.values(data.byCountry).flat().map((r) => String(r[0]));
const listed = new Set(ids);
const found = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const checked = new Set(existsSync(CHECKED) ? JSON.parse(readFileSync(CHECKED, "utf8")) : []);
// runs from before this file existed checked every city then on the list
if (!checked.size && existsSync(`${CACHE}/located-in-done.json`) && existsSync(".cache/cities-13k.json"))
  for (const r of Object.values(JSON.parse(readFileSync(".cache/cities-13k.json", "utf8")).byCountry).flat()) checked.add(String(r[0]));
const todo = ids.filter((id) => !checked.has(id));
console.log(`${todo.length} of ${ids.length} cities still to look up`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function query(batch) {
  const values = batch.map((id) => `"${id}"`).join(" ");
  const q = `SELECT DISTINCT ?g ?ag WHERE { VALUES ?g { ${values} } ?i wdt:P1566 ?g. ?i wdt:P131+ ?a. ?a wdt:P1566 ?ag. }`;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch("https://query.wikidata.org/sparql", {
        method: "POST",
        headers: { "User-Agent": UA, Accept: "application/sparql-results+json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ query: q }),
      });
      if (res.ok) return (await res.json()).results.bindings; // a dropped connection here is retried too
    } catch { /* retry */ }
    await sleep(5000 * attempt);
  }
  throw new Error("wikidata keeps failing");
}

for (let i = 0; i < todo.length; i += BATCH) {
  const batch = todo.slice(i, i + BATCH);
  for (const b of await query(batch)) {
    const g = b.g.value, a = b.ag.value;
    if (a !== g && listed.has(a)) (found[g] ||= []).includes(a) || found[g].push(a);
  }
  for (const id of batch) checked.add(id);
  writeFileSync(OUT, JSON.stringify(found));
  writeFileSync(CHECKED, JSON.stringify([...checked]));
  console.log(`${Math.min(i + BATCH, todo.length)}/${todo.length} checked, ${Object.keys(found).length} are inside another listed place`);
  await sleep(500);
}
console.log(`done: ${Object.keys(found).length} listed places are inside another listed place`);
