// Dashboard: home community, live position / roles / badges, claiming from the dashboard,
// local + national feeds with votes, reports and moderators, "add my town" requests, live ranks.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/index.js";
import { base58Decode, base58Encode, buildMessage, statementFor } from "../src/solana.js";
import { _resetCityCache } from "../src/cities.js";
import { _resetSnapshots } from "../src/chain.js";
import { _resetRoles } from "../src/roles.js";
import { encodeArea } from "../src/geo.js";
import { weekStart } from "../src/social.js";
import { d1 } from "./helpers/d1.js";

const HOST = "vicinity.test", ORIGIN = `https://${HOST}`;
const MINT = "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm";
const CITIES = { source: "test", countries: { US: "United States" }, admin: {}, byCountry: { US: [
  [5128581, "New York City", "NY", 40.71, -74.01, 8800000],
  [5140405, "Syracuse", "NY", 43.05, -76.15, 142000],
  [5106834, "Albany", "NY", 42.65, -73.76, 99000],
  [5142056, "Utica", "NY", 43.1, -75.23, 61100],
] } };
const square = (w, s, e, n) => [[[[w, s], [e, s], [e, n], [w, n], [w, s]]]];
const line = (id, kind, [w, s, e, n]) => `${id}\t${kind}\t${w},${s},${e},${n}\t${JSON.stringify(encodeArea(square(w, s, e, n)))}`;
const BOUNDS = [
  line(5128581, "r", [-74.3, 40.5, -73.7, 40.95]),
  line(5140405, "n", [-76.3, 42.95, -76.0, 43.15]),
  line(5106834, "r", [-73.9, 42.55, -73.65, 42.75]),
  line(5142056, "r", [-75.35, 43.0, -75.1, 43.2]),
].join("\n");
const assets = { fetch: async (r) => {
  const p = new URL(r.url).pathname;
  if (p === "/data/cities.json") return new Response(JSON.stringify(CITIES));
  if (p === "/data/bounds/US.txt") return new Response(BOUNDS);
  return new Response("", { status: 404 });
} };
const IN_UTICA = { lat: 43.1, lon: -75.23, accuracy: 30 };
const IN_NYC = { lat: 40.71, lon: -74.0, accuracy: 30 };
const EMPTY = { lat: 42.4, lon: -75.0, accuracy: 30 };

let env, holdings;
// Fake Solana: every holder via getProgramAccounts (owner + amount bytes), balances, mint facts.
function chain() {
  return async (_u, init) => {
    const body = JSON.parse(init.body);
    const one = ({ method, params }) => {
      if (method === "getAccountInfo") return { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { decimals: 6, supply: "1000000000000000", mintAuthority: null, freezeAuthority: null } } } } };
      if (method === "getProgramAccounts") return Object.entries(holdings).filter(([, a]) => a > 0).map(([owner, amount], i) => {
        const bytes = new Uint8Array(40); bytes.set(base58Decode(owner), 0);
        let raw = BigInt(Math.round(amount * 1e6));
        for (let j = 0; j < 8; j++) { bytes[32 + j] = Number(raw & 255n); raw >>= 8n; }
        return { pubkey: "acc" + i, account: { data: [Buffer.from(bytes).toString("base64"), "base64"] } };
      });
      if (method === "getMultipleAccounts") return { value: params[0].map(() => ({ owner: "11111111111111111111111111111111" })) };
      if (method === "getTokenAccountsByOwner") { const a = holdings[params[0]] || 0; return { value: a ? [{ account: { data: { parsed: { info: { tokenAmount: { uiAmount: a } } } } } }] : [] }; }
      throw new Error("unexpected " + method);
    };
    const out = Array.isArray(body) ? body.map((b) => ({ jsonrpc: "2.0", id: b.id, result: one(b) })) : { jsonrpc: "2.0", id: 1, result: one(body) };
    return new Response(JSON.stringify(out));
  };
}

async function wallet() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const address = base58Encode(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
  const sign = async (text) => Buffer.from(await crypto.subtle.sign({ name: "Ed25519" }, kp.privateKey, new TextEncoder().encode(text))).toString("base64");
  return { address, sign };
}
/** A browser: keeps its cookies, sends Origin like real browsers. `fetchImpl` stands in for the internet. */
function browser() {
  const jar = new Map();
  const send = async (path, { method = "GET", body, fetchImpl = chain() } = {}) => {
    const headers = new Headers({ origin: ORIGIN });
    if (jar.size) headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
    const res = await handleApi(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetchImpl);
    for (const c of res.headers.getSetCookie()) { const [pair] = c.split("; "); const i = pair.indexOf("="); jar.set(pair.slice(0, i), pair.slice(i + 1)); }
    return res;
  };
  return { send, get: async (p) => (await send(p)).json(), post: async (p, body = {}) => (await send(p, { method: "POST", body })).json() };
}
let nextId = 1;
/** A signed-in person (wallet + Google), optionally with a home community. */
async function person({ home } = {}) {
  const w = await wallet(), b = browser();
  const message = buildMessage({ host: HOST, address: w.address, nonce: "abcdefghijklmnop", issuedAt: new Date().toISOString(), statement: statementFor("login") });
  await b.post("/api/auth/wallet", { address: w.address, message, signature: await w.sign(message) });
  const start = await b.send("/api/auth/google/start");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const id = "g" + nextId++;
  const google = async () => new Response(JSON.stringify({ id_token: "x." + Buffer.from(JSON.stringify({ iss: "accounts.google.com", aud: "gid", sub: id, given_name: "P" + id })).toString("base64url") + ".y" }));
  await b.send(`/api/auth/google/callback?code=c&state=${state}`, { fetchImpl: google });
  if (home) assert.equal((await b.post("/api/home", { location: home, country: "US" })).ok, true);
  return { w, ...b };
}

beforeEach(() => {
  _resetCityCache(); _resetSnapshots(); _resetRoles();
  holdings = {};
  env = { DB: d1(), ASSETS: assets, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "s" };
});
const launch = () => { env.VICINITY_MINT = MINT; _resetSnapshots(); _resetRoles(); };
const hold = (w, amount) => { holdings[w.address] = amount; _resetSnapshots(); _resetRoles(); };

test("home community: inside one → it's home; in empty land → pick one of the three nearest; then locked for a week", async () => {
  const a = await person();
  let d = await a.post("/api/home", { location: IN_UTICA, country: "US" });
  assert.equal(d.ok, true);
  assert.deepEqual(d.home, { id: "5142056", name: "Utica", country: "US" });
  assert.equal((await a.post("/api/home", { location: IN_NYC, country: "US" })).error, "home_locked");

  const b = await person();
  d = await b.post("/api/home", { location: EMPTY, country: "US" });
  assert.equal(d.needsChoice, true);
  assert.equal(d.nearby.length, 3);
  assert.equal(d.nearby[0].name, "Utica");
  assert.ok(d.nearby[0].km < d.nearby[1].km);
  assert.equal((await b.post("/api/home", { location: EMPTY, country: "US", choice: "5128581" })).needsChoice, true, "only the three nearest");
  d = await b.post("/api/home", { location: EMPTY, country: "US", choice: d.nearby[1].id });
  assert.equal(d.ok, true);
  assert.equal(d.joinedNearby, true);

  const c = await person();
  assert.equal((await c.post("/api/home", { location: { lat: 43.1, lon: -75.2, accuracy: 50_000 }, country: "US" })).error, "location_too_rough");
  assert.equal((await browser().post("/api/home", { location: IN_UTICA, country: "US" })).error, "sign_in");
});

test("dashboard before launch: early member, verified, local; ranks wait for launch", async () => {
  const a = await person({ home: IN_UTICA });
  const me = await a.get("/api/me");
  assert.equal(me.signedIn, true);
  assert.equal(me.launched, false);
  assert.equal(me.level, "member");
  const earned = me.badges.filter((b) => b.earned).map((b) => b.id);
  assert.deepEqual(earned, ["early", "verified", "local"]);
  assert.equal(me.community.name, "Utica");
  assert.equal(me.community.members, 1);
  assert.equal(me.holding.rank, null);
  assert.equal(me.progress.steps.find((s) => s.id === "home").done, true);
  assert.equal(me.progress.claimable, false);
  assert.equal((await browser().get("/api/me")).signedIn, false);
});

test("live after launch: rank, founder-ready, claim from the dashboard, manager; selling takes badges away", async () => {
  const a = await person({ home: IN_UTICA }), b = await person({ home: IN_UTICA }), c = await person({ home: IN_NYC });
  launch();
  hold(a.w, 2_000_000); hold(b.w, 5_000); hold(c.w, 50_000_000);
  let me = await a.get("/api/me");
  assert.equal(me.level, "holder");
  assert.equal(me.holding.rank, 2);
  assert.equal(me.holding.total, 3);
  assert.equal(me.holding.next.gap, 48_000_000);
  assert.equal(me.community.rank, 1);
  assert.equal(me.community.holders, 2);
  assert.equal(me.national.rank, 2);
  assert.ok(me.badges.find((x) => x.id === "founder_ready").earned);
  assert.equal(me.progress.claimable, true);

  // claim Utica from the dashboard (signed in: no extra signature needed), standing in it
  let r = await a.post("/api/claim", { cityId: "5142056", country: "US", location: IN_UTICA });
  assert.equal(r.claimed, true);
  assert.equal((await b.post("/api/claim", { cityId: "5142056", country: "US", location: IN_UTICA })).error, "city_taken");
  assert.equal((await c.post("/api/claim", { cityId: "5142056", country: "US", location: IN_NYC })).error, "not_in_city");
  me = await a.get("/api/me");
  assert.equal(me.level, "manager", "the only founder in the US is its country manager");
  assert.ok(me.badges.find((x) => x.id === "city_founder").earned);
  assert.ok(me.badges.find((x) => x.id === "country_manager").earned);
  assert.equal(me.roles.weight, 3);

  // sells most of it: founder and manager badges go on the next check
  hold(a.w, 500);
  me = await a.get("/api/me");
  assert.equal(me.level, "holder");
  assert.equal(me.claim.atRisk, true);
  assert.ok(me.lost.includes("city_founder"));
  assert.ok(me.lost.includes("founder_ready"));
  assert.ok(!me.lost.includes("holder"));
});

test("feeds: post, see only your city (and your country), vote with role weight, report, moderate", async () => {
  const a = await person({ home: IN_UTICA }), b = await person({ home: IN_UTICA }), n = await person({ home: IN_NYC });
  let d = await a.post("/api/posts", { scope: "city", kind: "meme", body: "The Boilermaker hill has a name 😂" });
  assert.equal(d.ok, true);
  const id = d.post.id;
  assert.equal(d.post.author.name, "Pg" + (nextId - 3));
  assert.equal((await a.post("/api/posts", { scope: "city", kind: "meme", body: "Buy EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm now" })).error, "no_addresses");
  assert.equal((await a.post("/api/posts", { scope: "city", kind: "talk", body: "x".repeat(1001) })).error, "too_long");
  await a.post("/api/posts", { scope: "country", kind: "talk", body: "Which NY city has the best pizza?" });

  let feed = await b.get("/api/posts?scope=city&kind=meme");
  assert.equal(feed.posts.length, 1);
  assert.equal(feed.posts[0].author.wallet, undefined, "feeds never show wallets");
  assert.equal((await n.get("/api/posts?scope=city&kind=meme")).posts.length, 0, "NYC doesn't see Utica's local feed");
  assert.equal((await n.get("/api/posts?scope=country&kind=talk")).posts.length, 1, "but the whole country shares the national feed");

  d = await b.post("/api/posts/vote", { id });
  assert.deepEqual([d.voted, d.score, d.weight], [true, 1, 1]);
  assert.equal((await a.post("/api/posts/vote", { id })).error, "own_post");
  assert.equal((await n.post("/api/posts/vote", { id })).error, "not_found");
  feed = await b.get("/api/posts?scope=city&kind=meme&sort=top");
  assert.equal(feed.posts[0].voted, true);
  d = await b.post("/api/posts/vote", { id });
  assert.equal(d.voted, false);
  assert.equal(d.score, 0);

  // replies
  await b.post("/api/posts", { parent: id, body: "Every local knows it" });
  assert.equal((await a.get(`/api/posts?parent=${id}`)).posts.length, 1);
  assert.equal((await a.get("/api/posts?scope=city&kind=meme")).posts[0].replies, 1);

  // not a moderator → can't hide; the admin can
  assert.equal((await b.post("/api/posts/hide", { id })).error, "not_allowed");
  env.ADMIN_WALLETS = a.w.address;
  assert.equal((await a.post("/api/posts/hide", { id })).hidden, true);
  assert.equal((await b.get("/api/posts?scope=city&kind=meme")).posts.length, 0);
  const q = await a.get("/api/mod");
  assert.equal(q.moderator, true);
  assert.equal((await b.get("/api/mod")).moderator, false);
  assert.match(weekStart(Date.parse("2026-09-26T12:00:00Z")), /^2026-09-21T00:00:00/);
});

test("reports: five hide a post; bans stop posting; after launch only holders post", async () => {
  const author = await person({ home: IN_UTICA });
  const id = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "spam spam" })).post.id;
  for (let i = 0; i < 5; i++) { const p = await person({ home: IN_UTICA }); await p.post("/api/posts/report", { id, reason: "spam" }); }
  const again = await person({ home: IN_UTICA });
  assert.equal((await again.get("/api/posts?scope=city&kind=talk")).posts.length, 0);

  const admin = await person({ home: IN_UTICA });
  env.ADMIN_WALLETS = admin.w.address;
  const id2 = (await author.post("/api/posts", { scope: "city", kind: "talk", body: "more spam" })).post.id;
  assert.equal((await admin.post("/api/posts/ban", { id: id2, reason: "spam" })).banned, "*");
  assert.equal((await author.post("/api/posts", { scope: "city", kind: "talk", body: "hello?" })).error, "banned");

  launch();
  assert.equal((await again.post("/api/posts", { scope: "city", kind: "talk", body: "gm" })).error, "holders_only");
  hold(again.w, 10);
  assert.equal((await again.post("/api/posts", { scope: "city", kind: "talk", body: "gm" })).ok, true);
});

test("check-ins: only from inside your community, once a day; pictures are checked and served", async () => {
  const a = await person({ home: IN_UTICA });
  assert.equal((await a.post("/api/posts", { kind: "checkin", location: IN_NYC })).error, "not_in_city");
  const d = await a.post("/api/posts", { kind: "checkin", location: IN_UTICA });
  assert.equal(d.ok, true);
  assert.equal(d.post.body, "Checked in to Utica");
  assert.equal((await a.post("/api/posts", { kind: "checkin", location: IN_UTICA })).error, "checked_in_today");
  // the national tab shows every city's check-ins, with where they happened
  const n = await person({ home: IN_NYC });
  const nat = await n.get("/api/posts?scope=country&kind=checkin");
  assert.equal(nat.posts.length, 1);
  assert.equal(nat.posts[0].where, "Utica");
  assert.equal((await n.get("/api/posts?scope=city&kind=checkin")).posts.length, 0);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]).toString("base64");
  const m = await a.post("/api/posts", { scope: "city", kind: "meme", body: "", image: png });
  assert.equal(m.ok, true);
  const img = await a.send(m.post.image);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.equal((await img.arrayBuffer()).byteLength, 48);
  assert.equal((await a.post("/api/posts", { scope: "city", kind: "meme", image: Buffer.from("<svg onload=alert(1)>").toString("base64") })).error, "bad_image");
});

test("add-my-town requests: you must be there, one at a time, the country manager or admin decides", async () => {
  const a = await person({ home: IN_UTICA });
  let d = await a.post("/api/requests", { name: "New Hartford", location: { lat: 43.07, lon: -75.29, accuracy: 20 } });
  assert.equal(d.ok, true);
  assert.equal(d.request.near, "inside Utica");
  assert.equal((await a.post("/api/requests", { name: "Whitesboro", location: IN_UTICA })).error, "one_at_a_time");
  const row = await env.DB.prepare("SELECT lat, lon FROM requests").first();
  assert.deepEqual([row.lat, row.lon], [43.05, -75.3], "stored rounded to about 5 km");

  const other = await person({ home: IN_NYC });
  assert.equal((await other.post("/api/requests/decide", { id: d.request.id, approve: true })).error, "not_allowed");
  env.ADMIN_WALLETS = other.w.address;
  assert.equal((await other.get("/api/mod")).requests.length, 1);
  assert.equal((await other.post("/api/requests/decide", { id: d.request.id, approve: true, note: "Welcome!" })).status, "approved");
  assert.equal((await a.get("/api/requests")).requests[0].status, "approved");
});

test("public: member counts per community, live holder list and anyone's rank (nothing stored)", async () => {
  await person({ home: IN_UTICA }); await person({ home: IN_UTICA }); await person({ home: IN_NYC });
  const m = await browser().get("/api/members");
  assert.equal(m.members, 3);
  assert.deepEqual(m.communities[0], { id: "5142056", name: "Utica", country: "US", members: 2 });

  const x = await wallet(), y = await wallet();
  assert.equal((await browser().get(`/api/rank?address=${x.address}`)).launched, false);
  launch(); hold(x, 3_000_000); hold(y, 1_000);
  const h = await browser().get("/api/holders");
  assert.equal(h.full, true);
  assert.equal(h.total, 2);
  assert.equal(h.holders[0].owner, x.address);
  const r = await browser().get(`/api/rank?address=${y.address}`);
  assert.equal(r.rank, 2);
  assert.equal(r.next.gap, 2_999_000);
  assert.equal((await browser().get("/api/rank?address=nope")).error, "bad_address");
});
