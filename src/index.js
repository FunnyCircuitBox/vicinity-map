/**
 * Vicinity — backend (Cloudflare Worker).
 *
 * API:
 *   GET  /api/health          → is the backend up?
 *   GET  /api/official        → the official links list
 *   GET  /api/check?q=...     → "is this link / address / handle official?"
 *   GET  /api/message?address → the exact text a wallet signs to verify ownership
 *   POST /api/verify          → check a signed message from a Solana wallet, then
 *                               (after launch) check how much $VICINITY it holds
 *   GET  /api/token           → live token facts (supply, minting/freezing disabled)
 *   GET  /api/holders         → live top holders from the blockchain
 *   GET  /api/claims          → every claimed city + community-added cities
 *   POST /api/claim           → claim a city (signed message + live location + network check + 1M hold)
 *   GET  /api/moderator?country=US → that country's moderator (founder holding the most $VICINITY)
 *
 * Everything else is served from /public by Cloudflare's static asset handler.
 * Database (D1, binding DB) holds city claims only. Visitor locations are never saved.
 * Optional secret: SOLANA_RPC_URL.
 */
import { OFFICIAL, VICINITY_MINT, checkOfficial } from "./official.js";
import { getHolding, getHoldings, getTokenFacts, getTopHolders } from "./chain.js";
import { base58Encode, buildMessage, CITY_NAME_RE, isSolanaAddress, parseMessage, statementFor, verifySignature } from "./solana.js";
import { BIG_CITY_RADIUS_KM, CLAIM_MIN_HOLD, CLAIM_RADIUS_KM, MAX_LOCATION_ACCURACY_M, cleanLocation, countryBounds, countryCities, distanceKm, normName, radiusFor } from "./cities.js";
import { cityAt, findCityArea, inArea } from "./geo.js";
import { d1Store } from "./store.js";
import { networkCheck } from "./network.js";

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
  "Cache-Control": "no-store",
};

const MAX_AGE_MS = 10 * 60 * 1000; // a signed message is valid for 10 minutes
const MAX_BODY = 4096;

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function base64ToBytes(b64) {
  if (typeof b64 !== "string" || b64.length > 200 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new Error("bad_b64");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const activeMint = (env) => (env && env.VICINITY_MINT) || VICINITY_MINT;

/** Cache small JSON answers for a short time so we don't hammer the blockchain. */
async function cached(key, seconds, produce) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const req = new Request("https://cache.vicinity.internal/" + key);
  if (cache) { const hit = await cache.match(req); if (hit) return hit; }
  const res = await produce();
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("Cache-Control", `public, max-age=${seconds}`);
    await cache.put(req, copy);
  }
  return res;
}

/**
 * Read a signed-message request and check it fully: format, this site, not expired,
 * and a real signature from the address. Returns { parsed, body } or { error: Response }.
 */
async function readSigned(request, now, actions, errKey) {
  const bad = (error, status = 400) => ({ error: json({ [errKey]: false, error }, status) });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return bad("too_large", 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return bad("too_large", 413);
    body = JSON.parse(text);
  } catch {
    return bad("bad_json");
  }
  const { address, message, signature } = body || {};
  if (!isSolanaAddress(address)) return bad("bad_address");

  const parsed = parseMessage(message);
  if (!parsed || !actions.includes(parsed.action)) return bad("bad_message");

  const host = new URL(request.url).host;
  if (parsed.host !== host) return bad("wrong_site");
  if (parsed.address !== address) return bad("address_mismatch");

  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > MAX_AGE_MS) return bad("expired");

  let sig;
  try { sig = base64ToBytes(signature); } catch { return bad("bad_signature"); }

  let ok = false;
  try { ok = await verifySignature(address, message, sig); } catch { ok = false; }
  if (!ok) return bad("signature_mismatch", 401);
  return { parsed, body };
}

export async function handleVerify(request, env = {}, now = Date.now(), fetchImpl = fetch) {
  const r = await readSigned(request, now, ["verify"], "verified");
  if (r.error) return r.error;
  const address = r.parsed.address;

  console.log("wallet verified", address.slice(0, 4) + "…" + address.slice(-4));
  const out = { verified: true, address, verifiedAt: new Date(now).toISOString(), launched: false };
  const mint = activeMint(env);
  if (mint) {
    out.launched = true;
    try {
      const amount = await getHolding(env, address, mint, fetchImpl);
      out.holder = amount > 0;
      out.amount = amount;
      out.tier = amount > 0 ? "Founding Supporter" : null;
      out.canClaim = amount >= CLAIM_MIN_HOLD;
    } catch (e) {
      console.error("holding lookup failed", String(e));
      out.holderCheck = "unavailable";
    }
  }
  if (env.DB || env.store) {
    try { out.city = await storeFor(env).claimByWallet(address); } catch { /* optional */ }
  }
  return json(out);
}

export const claimRules = (env) => ({ minHold: CLAIM_MIN_HOLD, radiusKm: CLAIM_RADIUS_KM, bigCityRadiusKm: BIG_CITY_RADIUS_KM, open: Boolean(activeMint(env)) });

export const storeFor = (env) => env.store || d1Store(env.DB);


/**
 * Claim a city (or add a missing one and claim it).
 * Body: { address, message, signature, location: { lat, lon, accuracy } }
 * The location is used for the "inside the city" check only and is never saved.
 */
export async function handleClaim(request, env = {}, now = Date.now(), fetchImpl = fetch, cf = request.cf) {
  const r = await readSigned(request, now, ["claim", "add"], "claimed");
  if (r.error) return r.error;
  const { parsed, body } = r;
  const wallet = parsed.address;
  const no = (error, status = 400, extra = {}) => json({ claimed: false, error, ...extra }, status);

  if (!env.DB && !env.store) return no("claims_unavailable", 503);
  const store = storeFor(env);

  const mint = activeMint(env);
  if (!mint) return no("not_launched", 409);

  const loc = cleanLocation(body.location);
  if (!loc) return no("location_required");
  if (loc.accuracy > MAX_LOCATION_ACCURACY_M) return no("location_too_rough");

  let listed;
  try { listed = await countryCities(env, parsed.country); } catch { return no("cities_unavailable", 503); }
  if (!listed) return no("unknown_country");
  let bounds = null; // city boundaries are optional: without them the distance rule applies
  try { bounds = await countryBounds(env, parsed.country); } catch { /* fall back to distance */ }

  // Which city, and is the visitor inside it?
  let city;
  if (parsed.action === "claim") {
    const id = parsed.cityId;
    if (id.startsWith("c")) {
      const a = await store.addedCity(Number(id.slice(1)));
      city = a && a.country === parsed.country && { id, name: a.name, country: a.country, lat: a.lat, lon: a.lon, pop: 0 };
    } else city = listed.find((c) => c.id === id);
    if (!city) return no("unknown_city", 404);
  } else {
    const norm = normName(parsed.name);
    const same = listed.find((c) => normName(c.name) === norm && distanceKm(loc.lat, loc.lon, c.lat, c.lon) <= 60);
    const added = (await store.addedByName(parsed.country, norm)).find((c) => distanceKm(loc.lat, loc.lon, c.lat, c.lon) <= 60);
    const dup = same || (added && { id: "c" + added.id, name: added.name });
    if (dup) return no("already_listed", 409, { cityId: String(dup.id), cityName: dup.name });
    // standing inside a listed city's boundary? then that city is the one to claim
    const inside = bounds && cityAt(bounds, loc.lon, loc.lat);
    if (inside) return no("inside_listed_city", 409, { cityId: inside, cityName: listed.find((c) => c.id === inside)?.name });
    // New city center = the visitor's spot rounded to about 10 km, so no home location is revealed.
    city = { id: null, name: parsed.name, country: parsed.country, lat: Math.round(loc.lat * 10) / 10, lon: Math.round(loc.lon * 10) / 10, pop: 0 };
  }

  if (city.id) {
    const row = bounds && !city.id.startsWith("c") ? findCityArea(bounds, city.id) : null;
    if (row?.kind === "p") return no("part_of", 409, { parentId: row.parent });
    if (row?.kind === "o") return no("not_a_community", 409); // too small, in empty land: pick a nearby community
    if (row?.area) {
      if (!inArea(loc.lon, loc.lat, row.area)) return no("not_in_city", 403);
    } else {
      const dist = distanceKm(loc.lat, loc.lon, city.lat, city.lon);
      if (dist > radiusFor(city)) return no("not_in_city", 403, { km: Math.round(dist), radiusKm: radiusFor(city) });
    }
  }

  // Does the internet connection agree with the GPS? (blocks VPNs, proxies and far-away spoofing)
  const net = networkCheck(cf, loc, city.country);
  if (net) {
    console.log("claim blocked by network check", net.error, cf && cf.country);
    return no(net.error, 403, net);
  }

  // One wallet, one city.
  const mine = await store.claimByWallet(wallet);
  if (mine) return no("wallet_has_city", 409, { city: mine });
  if (city.id) {
    const taken = await store.claimByCity(city.id);
    if (taken) return no("city_taken", 409, { by: taken.wallet });
  }

  // Must hold enough $VICINITY right now (checked live on the blockchain).
  let amount;
  try { amount = await getHolding(env, wallet, mint, fetchImpl); }
  catch (e) { console.error("holding lookup failed", String(e)); return no("chain_unavailable", 503); }
  if (amount < CLAIM_MIN_HOLD) return no("not_enough_tokens", 403, { amount, required: CLAIM_MIN_HOLD });

  const at = new Date(now).toISOString();
  try {
    if (city.id) await store.insertClaim({ cityId: city.id, wallet, cityName: city.name, country: city.country, at });
    else city.id = await store.insertAddedCityAndClaim({ name: city.name, norm: normName(city.name), country: city.country, lat: city.lat, lon: city.lon, wallet, at });
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) return no("city_taken", 409);
    console.error("claim insert failed", String(e));
    return no("claims_unavailable", 503);
  }
  console.log("city claimed", city.id, wallet.slice(0, 4) + "…" + wallet.slice(-4));
  return json({ claimed: true, cityId: city.id, cityName: city.name, country: city.country, wallet, claimedAt: at, amount });
}

/**
 * Country moderator = the city founder in that country who holds the most $VICINITY
 * right now (checked live on-chain). Team wallets can't be moderators.
 * The final moderator is fixed at the Launchpad snapshot.
 */
export async function handleModerator(env, cc, fetchImpl = fetch) {
  const mint = activeMint(env);
  const base = { country: cc, launched: Boolean(mint), rule: "The city founder in this country holding the most $VICINITY. Fixed at the Launchpad snapshot." };
  if (!mint || (!env.DB && !env.store)) return json({ ...base, moderator: null, founders: 0 });
  try {
    const team = new Set(OFFICIAL.teamWallets || []);
    const founders = (await storeFor(env).claimsByCountry(cc)).filter((f) => !team.has(f.wallet));
    if (!founders.length) return json({ ...base, moderator: null, founders: 0 });
    const bal = await getHoldings(env, founders.map((f) => f.wallet), mint, fetchImpl);
    let best = null;
    for (const f of founders) {
      const amount = bal.get(f.wallet) || 0;
      if (!best || amount > best.amount) best = { wallet: f.wallet, city: f.city_name, cityId: f.city_id, amount };
    }
    return json({ ...base, moderator: best && best.amount > 0 ? best : null, founders: founders.length, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("moderator lookup failed", String(e));
    return json({ ...base, error: "chain_unavailable" }, 503);
  }
}

export async function handleApi(request, env = {}, fetchImpl = fetch) {
  const url = new URL(request.url);
  const method = request.method;
  const only = (m) => (method === m ? null : json({ error: "method_not_allowed" }, 405));

  switch (url.pathname) {
    case "/api/health":
      return only("GET") || json({ ok: true, service: "vicinity-map", milestone: 1 });
    case "/api/official":
      return only("GET") || json(OFFICIAL);
    case "/api/check":
      return only("GET") || json(checkOfficial(url.searchParams.get("q"), isSolanaAddress));
    case "/api/verify":
      return only("POST") || handleVerify(request, env, Date.now(), fetchImpl);
    case "/api/token": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, registry: OFFICIAL.tokens });
      return cached("token-" + mint, 60, async () => {
        try { return json({ launched: true, registry: OFFICIAL.tokens, facts: await getTokenFacts(env, mint, fetchImpl) }); }
        catch (e) { console.error("token facts failed", String(e)); return json({ launched: true, error: "chain_unavailable" }, 503); }
      });
    }
    case "/api/holders": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, holders: [] });
      return cached("holders-" + mint, 60, async () => {
        try {
          const { facts, holders } = await getTopHolders(env, mint, fetchImpl);
          return json({ launched: true, mint, supply: facts.supply, holders, updatedAt: new Date().toISOString() });
        } catch (e) {
          console.error("holders failed", String(e));
          return json({ launched: true, error: "chain_unavailable" }, 503);
        }
      });
    }
    case "/api/message": {
      // Helper so the browser builds exactly the same text the server expects.
      const blocked = only("GET");
      if (blocked) return blocked;
      const q = url.searchParams;
      const address = q.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const action = q.get("action") || "verify";
      let statement;
      if (action === "verify") statement = statementFor("verify");
      else if (action === "claim" && /^([0-9]{1,10}|c[0-9]{1,9})$/.test(q.get("city") || "") && /^[A-Z]{2}$/.test(q.get("country") || ""))
        statement = statementFor("claim", { cityId: q.get("city"), country: q.get("country") });
      else if (action === "add" && CITY_NAME_RE.test((q.get("name") || "").trim()) && /^[A-Z]{2}$/.test(q.get("country") || ""))
        statement = statementFor("add", { name: q.get("name").trim().replace(/\s+/g, " "), country: q.get("country") });
      else return json({ error: "bad_request" }, 400);
      const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
      const issuedAt = new Date().toISOString();
      return json({ message: buildMessage({ host: url.host, address, nonce, issuedAt, statement }) });
    }
    case "/api/claim":
      return only("POST") || handleClaim(request, env, Date.now(), fetchImpl);
    case "/api/moderator": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const cc = url.searchParams.get("country") || "";
      if (!/^[A-Z]{2}$/.test(cc)) return json({ error: "bad_country" }, 400);
      return cached("moderator-" + cc + "-" + (activeMint(env) || "none"), 120, () => handleModerator(env, cc, fetchImpl));
    }
    case "/api/claims": {
      const blocked = only("GET");
      if (blocked) return blocked;
      if (!env.DB && !env.store) return json({ open: false, claims: [], added: [], rules: claimRules(env) });
      try {
        const all = await storeFor(env).listAll();
        return json({ open: Boolean(activeMint(env)), ...all, rules: claimRules(env) });
      } catch (e) {
        console.error("claims list failed", String(e));
        return json({ error: "claims_unavailable" }, 503);
      }
    }
    default:
      return json({ error: "not_found" }, 404);
  }
}

export function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (k !== "Cache-Control") res.headers.set(k, v);
  return res;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return await handleApi(request, env);
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500);
    }
  },
};
