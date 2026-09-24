// Checks the generated city areas (public/data/bounds) for overlaps, across all countries.
// node scripts/boundaries/check-overlaps.mjs      → lists every overlap bigger than 1 m², exit code 1 if any
import { readFileSync, readdirSync } from "node:fs";
import { decodeArea } from "../../src/geo.js";
import { findOverlaps } from "./overlaps.mjs";

const data = JSON.parse(readFileSync("public/data/cities.json", "utf8"));
const names = new Map(Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map((r) => [String(r[0]), `${r[1]} (${cc})`])));
const items = [];
for (const file of readdirSync("public/data/bounds").filter((f) => f.endsWith(".txt")))
  for (const line of readFileSync(`public/data/bounds/${file}`, "utf8").split("\n")) {
    const [id, kind, box, json] = line.split("\t");
    if (json) items.push({ id, kind, box: box.split(",").map(Number), area: decodeArea(JSON.parse(json)) });
  }
const t0 = Date.now();
const found = findOverlaps(items, 1e-6);
console.log(`${items.length} areas checked in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${found.length} overlaps bigger than 1 m²`);
for (const { a, b, km2 } of found.slice(0, 40))
  console.log(`  ${km2 === null ? "  (couldn't measure)" : (km2 * 1e6).toFixed(1).padStart(12) + " m²"}  ${names.get(a.id)} [${a.kind}]  ×  ${names.get(b.id)} [${b.kind}]`);
if (found.length > 40) console.log(`  … and ${found.length - 40} more`);
process.exit(found.length ? 1 : 0);
