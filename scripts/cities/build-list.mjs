// Builds public/data/cities.json: every populated place with 1,000+ people (GeoNames, CC BY 4.0).
// Cities already on the list keep their id and name (claims point at the id; "New York City" stays
// "New York City"). Coordinates are kept to 4 decimals (≈ 10 m).
// Each row: [id, name, admin1 code, lat, lon, population, seat]; seat = 1 for a capital or county seat
// (GeoNames PPLC / PPLA / PPLA2): it names a merged coin when two towns are about the same size.
// Downloads (cached in .cache/geonames/): cities1000.zip, admin1CodesASCII.txt, countryInfo.txt
//   node scripts/cities/build-list.mjs
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CACHE = ".cache/geonames";
// the list to update (LIST=path to build a list elsewhere, e.g. while the site still uses the old one)
const OUT = process.env.LIST || "public/data/cities.json";
const MIN_POP = 1000;
const BASE = "https://download.geonames.org/export/dump";
mkdirSync(CACHE, { recursive: true });

async function download(name) {
  const file = `${CACHE}/${name}`;
  if (existsSync(file)) return file;
  const res = await fetch(`${BASE}/${name}`);
  if (!res.ok) throw new Error(`couldn't download ${name} (${res.status})`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}
await download("cities1000.zip");
if (!existsSync(`${CACHE}/cities1000.txt`)) {
  // unzip with whatever the system has (tar handles zip on Windows 10+, macOS and most Linux)
  execFileSync("tar", ["-xf", "cities1000.zip"], { cwd: CACHE });
}
const tsv = (file) => readFileSync(file, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split("\t"));
const places = tsv(`${CACHE}/cities1000.txt`);
const admin1 = tsv(await download("admin1CodesASCII.txt"));
const countryInfo = tsv(await download("countryInfo.txt"));

const old = JSON.parse(readFileSync(OUT, "utf8"));
const oldRows = new Map(Object.values(old.byCountry).flat().map((r) => [String(r[0]), r]));

const byCountry = {};
const round4 = (v) => Math.round(Number(v) * 1e4) / 1e4;
let added = 0;
for (const r of places) {
  const [id, name, , , lat, lon, fclass, fcode, cc, , adm1, , , , pop] = r;
  if (fclass !== "P" || !cc) continue;
  const keep = oldRows.get(id);
  if (!keep && Number(pop) < MIN_POP) continue;
  if (!keep) added++;
  (byCountry[cc] ||= []).push([Number(id), keep ? keep[1] : name, adm1, round4(lat), round4(lon), Number(pop) || (keep ? keep[5] : 0), /^PPL(C|A|A2)$/.test(fcode) ? 1 : 0]);
}
for (const rows of Object.values(byCountry)) rows.sort((a, b) => b[5] - a[5]);
const listed = new Set(Object.values(byCountry).flat().map((r) => String(r[0])));
const missing = [...oldRows.keys()].filter((id) => !listed.has(id));
if (missing.length) throw new Error(`${missing.length} cities from the old list are missing, e.g. ${missing.slice(0, 5).join(", ")}`);

const countries = { ...old.countries };
for (const r of countryInfo) if (r[0] && byCountry[r[0]] && !countries[r[0]]) countries[r[0]] = r[4];
const admin = {};
const adminNames = new Map(admin1.map((r) => [r[0], r[2] || r[1]]));
for (const [cc, rows] of Object.entries(byCountry)) for (const r of rows) {
  const key = `${cc}.${r[2]}`;
  const n = old.admin[key] ?? adminNames.get(key);
  if (n) admin[key] = n;
}
const sorted = Object.fromEntries(Object.keys(byCountry).sort().map((cc) => [cc, byCountry[cc]]));
writeFileSync(OUT, JSON.stringify({ source: "GeoNames (geonames.org), CC BY 4.0: populated places with 1,000+ people", countries, admin, byCountry: sorted }));
const total = Object.values(sorted).flat().length;
console.log(`${total.toLocaleString()} places in ${Object.keys(sorted).length} countries (${added.toLocaleString()} new), ${(readFileSync(OUT).length / 1e6).toFixed(1)} MB`);
