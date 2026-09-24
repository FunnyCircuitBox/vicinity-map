import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handleApi, handleClaim } from "../src/index.js";
import { buildMessage, base58Encode, parseMessage, statementFor } from "../src/solana.js";
import { _resetCityCache, distanceKm, normName } from "../src/cities.js";
import { memoryStore } from "../src/store.js";

const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const HOST = "vicinity.test";
const UTICA = { lat: 43.10, lon: -75.23 };       // near Utica, NY (city #5142056 below)
const NYC = { lat: 40.71, lon: -74.01 };
const TINY = { source: "test", countries: { BD: "Bangladesh", US: "United States" }, admin: {}, byCountry: {
  BD: [[1185241, "Dhaka", "81", 23.71, 90.41, 10400000]],
  US: [[5128581, "New York City", "NY", 40.71, -74.01, 8800000], [5142056, "Utica", "NY", 43.1, -75.23, 61100]],
} };
const assets = { fetch: async (r) => (new URL(r.url).pathname === "/data/cities.json" ? new Response(JSON.stringify(TINY)) : new Response("", { status: 404 })) };

function rpc(holdings) {
  return async (_u, init) => {
    const { method, params } = JSON.parse(init.body);
    if (method !== "getTokenAccountsByOwner") throw new Error("unexpected " + method);
    const amt = holdings[params[0]] || 0;
    return new Response(JSON.stringify({ result: { value: amt ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: amt } } } } } }] : [] } }));
  };
}
async function wallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) => Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
async function claimReq(w, action, target, location, { host = HOST, issuedAt = new Date().toISOString() } = {}) {
  const statement = statementFor(action, target);
  const message = buildMessage({ host, address: w.address, nonce: "abcdefghijklmnop", issuedAt, statement });
  const body = JSON.stringify({ address: w.address, message, signature: await w.sign(message), location });
  return new Request(`https://${HOST}/api/claim`, { method: "POST", body });
}

let env, holdings;
beforeEach(() => { _resetCityCache(); holdings = {}; env = { VICINITY_MINT: MINT, ASSETS: assets, store: memoryStore() }; });
const send = async (r) => { const res = await handleClaim(r, env, Date.now(), rpc(holdings)); return { status: res.status, ...(await res.json()) }; };

test("claim messages round-trip and say they are free", () => {
  for (const [a, t] of [["claim", { cityId: "5142056", country: "US" }], ["claim", { cityId: "c12", country: "US" }], ["add", { name: "Sylhet", country: "BD" }], ["add", { name: "Coeur d'Alene", country: "US" }]]) {
    const m = buildMessage({ host: HOST, address: "11111111111111111111111111111111", nonce: "abcdefghijklmnop", issuedAt: "2026-09-23T00:00:00.000Z", statement: statementFor(a, t) });
    const p = parseMessage(m);
    assert.equal(p.action, a);
    assert.match(m, /Free, not a transaction, cannot move funds\./);
  }
  const evil = buildMessage({ host: HOST, address: "11111111111111111111111111111111", nonce: "abcdefghijklmnop", issuedAt: "2026-09-23T00:00:00.000Z", statement: 'Add the city "<script>" (US) and claim it for this wallet on Vicinity. Free, not a transaction, cannot move funds.' });
  assert.equal(parseMessage(evil), null);
});

test("message endpoint builds claim and add messages, rejects junk", async () => {
  const w = await wallet();
  const get = (q) => handleApi(new Request(`https://${HOST}/api/message?address=${w.address}&${q}`));
  assert.equal(parseMessage((await (await get("action=claim&city=5142056&country=US")).json()).message).cityId, "5142056");
  assert.equal(parseMessage((await (await get("action=add&name=Sylhet&country=BD")).json()).message).name, "Sylhet");
  assert.equal((await get("action=claim&city=../x&country=US")).status, 400);
  assert.equal((await get("action=claim&city=5142056")).status, 400);
  assert.equal((await get("action=add&name=%3Cb%3E&country=BD")).status, 400);
  assert.equal((await get("action=add&name=Sylhet&country=bd")).status, 400);
});

test("holder with 1M+ inside the city claims it", async () => {
  const w = await wallet(); holdings[w.address] = 1_500_000;
  const r = await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, { ...UTICA, accuracy: 30 }));
  assert.equal(r.status, 200); assert.equal(r.claimed, true); assert.equal(r.cityName, "Utica");
  const list = await (await handleApi(new Request(`https://${HOST}/api/claims`), env)).json();
  assert.equal(list.claims.length, 1); assert.equal(list.claims[0].wallet, w.address);
  assert.equal(JSON.stringify(list).includes("43.10"), false, "visitor location is never stored");
});

test("less than 1M $VICINITY cannot claim", async () => {
  const w = await wallet(); holdings[w.address] = 999_999;
  const r = await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, UTICA));
  assert.equal(r.status, 403); assert.equal(r.error, "not_enough_tokens"); assert.equal(r.required, 1_000_000);
});

test("must be inside the city", async () => {
  const w = await wallet(); holdings[w.address] = 2_000_000;
  const r = await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, NYC));
  assert.equal(r.status, 403); assert.equal(r.error, "not_in_city"); assert.equal(r.radiusKm, 25);
  assert.equal((await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, { ...UTICA, accuracy: 50_000 }))).error, "location_too_rough");
  assert.equal((await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, null))).error, "location_required");
  // big cities (1M+) get a 50 km radius
  assert.equal((await send(await claimReq(w, "claim", { cityId: "5128581", country: "US" }, { lat: 40.95, lon: -73.9 }))).claimed, true);
});

test("one wallet = one city, one city = one wallet", async () => {
  const a = await wallet(), b = await wallet(); holdings[a.address] = holdings[b.address] = 5_000_000;
  assert.equal((await send(await claimReq(a, "claim", { cityId: "5142056", country: "US" }, UTICA))).claimed, true);
  const again = await send(await claimReq(a, "claim", { cityId: "5128581", country: "US" }, NYC));
  assert.equal(again.error, "wallet_has_city"); assert.equal(again.city.city_name, "Utica");
  const taken = await send(await claimReq(b, "claim", { cityId: "5142056", country: "US" }, UTICA));
  assert.equal(taken.error, "city_taken"); assert.equal(taken.by, a.address);
});

test("closed before launch; bad signatures and other sites are refused", async () => {
  const w = await wallet(); holdings[w.address] = 5_000_000;
  env.VICINITY_MINT = null;
  assert.equal((await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, UTICA))).error, "not_launched");
  env.VICINITY_MINT = MINT;
  assert.equal((await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, UTICA, { host: "evil.test" }))).error, "wrong_site");
  assert.equal((await send(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, UTICA, { issuedAt: "2020-01-01T00:00:00.000Z" }))).error, "expired");
  const other = await wallet();
  const r = await claimReq(w, "claim", { cityId: "5142056", country: "US" }, UTICA);
  const body = JSON.parse(await r.text()); body.signature = await other.sign(body.message);
  assert.equal((await send(new Request(`https://${HOST}/api/claim`, { method: "POST", body: JSON.stringify(body) }))).error, "signature_mismatch");
  assert.equal((await send(await claimReq(w, "claim", { cityId: "999", country: "US" }, UTICA))).error, "unknown_city");
});

test("add a missing city: claimed by the adder, center rounded, duplicates refused", async () => {
  const a = await wallet(), b = await wallet(); holdings[a.address] = holdings[b.address] = 1_000_000;
  const here = { lat: 43.0487, lon: -75.3791 }; // New Hartford, NY
  const r = await send(await claimReq(a, "add", { name: "New Hartford", country: "US" }, here));
  assert.equal(r.claimed, true); assert.equal(r.cityId, "c1");
  const list = await (await handleApi(new Request(`https://${HOST}/api/claims`), env)).json();
  assert.deepEqual(list.added[0], { id: "c1", name: "New Hartford", country: "US", lat: 43, lon: -75.4 });
  assert.equal((await send(await claimReq(b, "add", { name: "new hartford", country: "US" }, here))).error, "already_listed");
  assert.equal((await send(await claimReq(b, "add", { name: "Utica", country: "US" }, UTICA))).error, "already_listed");
  assert.equal((await send(await claimReq(b, "add", { name: "Sylhet", country: "ZZ" }, here))).error, "unknown_country");
  assert.equal((await send(await claimReq(b, "claim", { cityId: "5142056", country: "BD" }, UTICA))).error, "unknown_city");
  // the added city can be claimed like any other (here: already claimed by its adder)
  assert.equal((await send(await claimReq(b, "claim", { cityId: "c1", country: "US" }, here))).error, "city_taken");
});

test("claims list says closed without a database, and shows the rules", async () => {
  const d = await (await handleApi(new Request(`https://${HOST}/api/claims`), {})).json();
  assert.equal(d.open, false); assert.equal(d.rules.minHold, 1_000_000);
  assert.equal((await handleClaim(await claimReq(await wallet(), "claim", { cityId: "1", country: "US" }, UTICA), {})).status, 503);
});

test("helpers: distance and name matching", () => {
  assert.ok(Math.abs(distanceKm(43.1, -75.23, 40.71, -74.01) - 285) < 10);
  assert.equal(normName("São Paulo"), normName("sao paulo"));
});

test("real city list covers every inhabited country", async () => {
  const text = readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8");
  const data = JSON.parse(text);
  const all = Object.values(data.byCountry).flat();
  assert.ok(all.length > 10_000);
  assert.ok(Object.keys(data.byCountry).length >= 240);
  assert.match(data.source, /GeoNames/);
  for (const n of ["Utica", "Dhaka", "Tokyo", "Lagos", "São Paulo"]) assert.ok(all.some((c) => c[1] === n), n);
  // the server's fast one-country reader gives the same answer as a full parse, for every country
  const { countryCities } = await import("../src/cities.js");
  _resetCityCache();
  const realEnv = { ASSETS: { fetch: async () => new Response(text) } };
  for (const [cc, rows] of Object.entries(data.byCountry)) assert.equal((await countryCities(realEnv, cc)).length, rows.length, cc);
  assert.equal(await countryCities(realEnv, "ZZ"), null);
});

test("network check: VPNs, Tor, other countries and far-away connections are refused", async () => {
  const w = await wallet(); holdings[w.address] = 2_000_000;
  const tryWith = async (cf) => { const res = await handleClaim(await claimReq(w, "claim", { cityId: "5142056", country: "US" }, UTICA), env, Date.now(), rpc(holdings), cf); return res.json(); };
  assert.equal((await tryWith({ country: "US", asOrganization: "DigitalOcean, LLC", latitude: "43.1", longitude: "-75.2" })).error, "vpn_detected");
  assert.equal((await tryWith({ country: "US", asOrganization: "Mullvad VPN AB" })).error, "vpn_detected");
  assert.equal((await tryWith({ country: "T1" })).error, "vpn_detected");
  const other = await tryWith({ country: "DE", asOrganization: "Deutsche Telekom AG", latitude: "52.5", longitude: "13.4" });
  assert.equal(other.error, "network_mismatch"); assert.equal(other.networkCountry, "DE");
  const far = await tryWith({ country: "US", asOrganization: "Comcast Cable", latitude: "34.05", longitude: "-118.24" }); // Los Angeles
  assert.equal(far.error, "network_mismatch"); assert.ok(far.networkKm > 3000);
  // a normal home/mobile connection nearby passes (mobile IPs are often 100-300 km off, so that's allowed)
  const ok = await tryWith({ country: "US", asOrganization: "Charter Communications", latitude: "43.05", longitude: "-76.15" }); // Syracuse
  assert.equal(ok.claimed, true);
});

test("country moderator = the founder in that country holding the most $VICINITY", async () => {
  const { handleModerator } = await import("../src/index.js");
  const { OFFICIAL } = await import("../src/official.js");
  const batchRpc = async (_u, init) => {
    const calls = JSON.parse(init.body);
    return new Response(JSON.stringify(calls.map((c) => ({ id: c.id, result: { value: holdings[c.params[0]] ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: holdings[c.params[0]] } } } } } }] : [] } }))));
  };
  // before launch: nobody yet
  env.VICINITY_MINT = null;
  assert.equal((await (await handleModerator(env, "US", batchRpc)).json()).moderator, null);
  env.VICINITY_MINT = MINT;
  const [a, b, c, team] = [await wallet(), await wallet(), await wallet(), await wallet()];
  holdings[a.address] = 1_200_000; holdings[b.address] = 9_000_000; holdings[c.address] = 3_000_000; holdings[team.address] = 50_000_000;
  await env.store.insertClaim({ cityId: "5142056", wallet: a.address, cityName: "Utica", country: "US", at: "2026-01-01" });
  await env.store.insertClaim({ cityId: "5128581", wallet: b.address, cityName: "New York City", country: "US", at: "2026-01-02" });
  await env.store.insertClaim({ cityId: "1185241", wallet: c.address, cityName: "Dhaka", country: "BD", at: "2026-01-03" });
  await env.store.insertClaim({ cityId: "999", wallet: team.address, cityName: "Test", country: "US", at: "2026-01-04" });
  OFFICIAL.teamWallets.push(team.address);
  try {
    const us = await (await handleModerator(env, "US", batchRpc)).json();
    assert.equal(us.moderator.wallet, b.address); assert.equal(us.moderator.city, "New York City"); assert.equal(us.founders, 2);
    assert.equal((await (await handleModerator(env, "BD", batchRpc)).json()).moderator.wallet, c.address);
    assert.equal((await (await handleModerator(env, "FR", batchRpc)).json()).moderator, null);
  } finally { OFFICIAL.teamWallets.pop(); }
  assert.equal((await handleApi(new Request(`https://${HOST}/api/moderator?country=us`), env)).status, 400);
});

test("city coin tickers are unique for every listed city, and same names are resolved", async () => {
  await import("../public/ticker.js");
  const data = JSON.parse(readFileSync(new URL("../public/data/cities.json", import.meta.url), "utf8"));
  const cities = Object.entries(data.byCountry).flatMap(([cc, rows]) => rows.map(([id, name, adm, , , pop]) => ({ id: String(id), name, cc, adm, pop })));
  const t = globalThis.vicinityTicker.assign(cities);
  const all = [...t.values()].map((v) => v.ticker);
  assert.equal(new Set(all).size, cities.length, "no two cities share a ticker");
  assert.ok(all.every((x) => /^[A-Z0-9]{2,10}$/.test(x)), "tickers are 2-10 capital letters/digits");
  const of = (name, cc) => t.get(cities.find((c) => c.name === name && c.cc === cc).id).ticker;
  assert.equal(of("Utica", "US"), "UTICA");
  assert.equal(of("London", "GB"), "LONDON");    // biggest keeps the plain ticker
  assert.equal(of("London", "CA"), "LONDONCA");  // the other adds its country
  assert.equal(of("New York City", "US"), "NYC");
  assert.equal(globalThis.vicinityTicker.baseTicker("Łódź"), "LODZ");
});
