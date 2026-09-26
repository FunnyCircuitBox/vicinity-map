// Builds the real-data New York City example on the home page (public/data/demo-nyc.json)
// and the site-wide numbers (public/data/stats.json). Run after the boundary build:
//   node scripts/demo/nyc.mjs
// Sources: New York City's official boundary (OpenStreetMap, downloaded by step 2 of the boundary
// build), the generated community areas (public/data/bounds/US.txt), the city list (GeoNames) and
// the coastline (Natural Earth).
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import pc from "polygon-clipping";
import { decodeArea } from "../../src/geo.js";
import { simplify } from "../boundaries/simplify.mjs";

const NYC = "5128581";
const NYC_OSM = "175905"; // OpenStreetMap relation: City of New York (the five boroughs)
const VIEW = [-75.0, 40.05, -73.0, 41.45];

const cities = JSON.parse(readFileSync("public/data/cities.json", "utf8"));
const us = new Map(cities.byCountry.US.map((r) => [String(r[0]), r]));
const index = JSON.parse(readFileSync("public/data/bounds/index.json", "utf8"));
const bounds = readFileSync("public/data/bounds/US.txt", "utf8");

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const tidy = (area, tol) => area.map((poly) => poly.map((ring) => simplify(ring, tol).map(([x, y]) => [r4(x), r4(y)]))).filter((p) => p[0].length >= 4);
const clip = (area) => pc.intersection(area, [[[VIEW[0], VIEW[1]], [VIEW[2], VIEW[1]], [VIEW[2], VIEW[3]], [VIEW[0], VIEW[3]], [VIEW[0], VIEW[1]]]]);
const boxHits = (b) => b[0] <= VIEW[2] && b[2] >= VIEW[0] && b[1] <= VIEW[3] && b[3] >= VIEW[1];

// 1. the official boundary: the five boroughs
const shapes = JSON.parse(readFileSync(".cache/boundaries/shapes/US.json", "utf8")).shapes;
const official = tidy(shapes[NYC_OSM], 0.0012);

// 2. the community areas in view: New York City's (official boundary + nearby towns + nearest land) and its neighbours'
let nyc = null;
const neighbors = [];
for (const line of bounds.split("\n")) {
  const [id, kind, box, json] = line.split("\t");
  if (kind !== "r" && kind !== "n") continue;
  if (!boxHits(box.split(",").map(Number))) continue;
  const row = us.get(id);
  const area = tidy(clip(decodeArea(JSON.parse(json))), 0.0015);
  if (!area.length) continue;
  const item = { id, name: row[1], state: row[2], lon: row[4], lat: row[3], pop: row[5], kind, area };
  if (id === NYC) nyc = item; else neighbors.push(item);
}
neighbors.sort((a, b) => b.pop - a.pop);

// 3. the listed places that are part of New York City's coin
const members = Object.entries(index.parts).filter(([, p]) => p === NYC).map(([id]) => us.get(id)).filter(Boolean)
  .sort((a, b) => b[5] - a[5]).map((r) => [r[1], r4(r[4]), r4(r[3]), r[5], r[2]]);

// 4. land (coastline) in view
const geo = JSON.parse(readFileSync(".cache/boundaries/countries.geojson", "utf8"));
const usa = geo.features.find((f) => (f.properties.ISO_A2_EH || f.properties.ISO_A2) === "US");
const polys = usa.geometry.type === "Polygon" ? [usa.geometry.coordinates] : usa.geometry.coordinates;
const land = tidy(clip(polys), 0.002);

const out = { view: VIEW, official, nyc, neighbors, members, land,
  sources: "Boundaries © OpenStreetMap contributors (ODbL) · places: GeoNames (CC BY 4.0) · coastline: Natural Earth" };
writeFileSync("public/data/demo-nyc.json", JSON.stringify(out));
console.log(`demo-nyc.json: ${members.length} places share New York City's coin, ${neighbors.length} neighbouring communities, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);

// Site-wide numbers for the home page
let official_ = 0, nearest = 0;
for (const f of readdirSync("public/data/bounds")) {
  if (!f.endsWith(".txt")) continue;
  for (const l of readFileSync(`public/data/bounds/${f}`, "utf8").split("\n")) { const k = l.split("\t")[1]; if (k === "r") official_++; else if (k === "n") nearest++; }
}
const places = Object.values(cities.byCountry).reduce((n, rows) => n + rows.length, 0);
const stats = { places, communities: official_ + nearest, officialBoundaries: official_, countries: Object.keys(index.countries).length, nycMembers: members.length };
writeFileSync("public/data/stats.json", JSON.stringify(stats));
console.log("stats.json:", stats);
