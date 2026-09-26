/**
 * Vicinity — backend (Cloudflare Worker).
 *
 * API:
 *   GET  /api/health          → is the backend up?
 *   GET  /api/official        → the official links list (+ when the Launchpad opens)
 *   GET  /api/check?q=...     → "is this link / address / handle official?"
 *   GET  /api/message?address&action=verify|login|claim|add → the exact text a wallet signs
 *   POST /api/verify          → check a signed message, then (after launch) how much $VICINITY it holds
 *   GET  /api/token           → live token facts (supply, minting/freezing disabled)
 *   GET  /api/holders         → live holder list (top 1,000, ranked; pools labeled, not ranked)
 *   GET  /api/rank?address=   → where one wallet stands among all holders (nothing stored)
 *   GET  /api/claims          → every claimed city + community-added cities
 *   POST /api/claim           → claim a city (signed in, or a signed message) + live location + network check + 1M hold
 *   GET  /api/moderator?country=US → that country's manager (founder holding the most $VICINITY)
 *   GET  /api/members         → how many people call each community home
 *
 *   Accounts (src/auth.js): POST /api/auth/wallet · POST /api/auth/transfer(/check) · POST /api/pair · GET /api/pair?code=
 *     · POST /api/pair/finish · GET /api/auth/{google,x}/start|callback · POST /api/auth/logout
 *   Dashboard (src/me.js):  GET /api/me · POST /api/home
 *   Feeds (src/social.js):  GET|POST /api/posts · POST /api/posts/{vote,report,hide,ban} · GET /api/mod
 *     · GET /api/media/:id · GET|POST /api/requests · POST /api/requests/decide
 *
 * Everything else is served from /public by Cloudflare's static asset handler.
 * Database (D1, binding DB): see src/store.js. Visitor locations are never saved.
 * Settings: SOLANA_RPC_URL, VICINITY_MINT, ADMIN_WALLETS, GOOGLE_CLIENT_ID/SECRET, X_CLIENT_ID/SECRET.
 */
import { OFFICIAL, activeMint, checkOfficial } from "./official.js";
import { getHolding, getHoldings, getTokenFacts, getTopHolders, holderSnapshot, rankOf } from "./chain.js";
import { base58Encode, buildMessage, CITY_NAME_RE, isSolanaAddress, statementFor } from "./solana.js";
import { BIG_CITY_RADIUS_KM, CLAIM_MIN_HOLD, CLAIM_RADIUS_KM, MAX_LOCATION_ACCURACY_M, cleanLocation, countryBounds, countryCities, distanceKm, normName, radiusFor } from "./cities.js";
import { cityAt, findCityArea, inArea } from "./geo.js";
import { storeFor } from "./store.js";
import { networkCheck } from "./network.js";
import { forgetManager } from "./roles.js";
import { SECURITY_HEADERS, json, sameSite } from "./http.js";
import { MAX_BODY, checkSigned, readSigned } from "./signed.js";
import { getSession, handleLogout, handleOAuthCallback, handleOAuthStart, handlePairFinish, handlePairStart, handlePairStatus,
  handleTransferCheck, handleTransferStart, handleWalletLogin } from "./auth.js";
import { handleHome, handleMe, handleMembers } from "./me.js";
import { handleBan, handleDecide, handleHide, handleMedia, handleModQueue, handleMyRequests, handleNewPost, handleNewRequest,
  handlePosts, handleReport, handleVote } from "./social.js";

export { json, activeMint, storeFor };

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

/**
 * Claim a city (or add a missing one and claim it).
 * Signed:     { address, message, signature, location: { lat, lon, accuracy } }   (message says which city)
 * Signed in:  { cityId, country, location }   (the dashboard: the session already proved the wallet)
 * The location is used for the "inside the city" check only and is never saved.
 */
export async function handleClaim(request, env = {}, now = Date.now(), fetchImpl = fetch, cf = request.cf) {
  const bad = (error, status = 400) => ({ error: json({ claimed: false, error }, status) });
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return bad("too_large", 413).error;
  const text = await request.text().catch(() => "");
  if (text.length > MAX_BODY) return bad("too_large", 413).error;
  let raw;
  try { raw = JSON.parse(text); } catch { return bad("bad_json").error; }

  if (raw && raw.signature == null && raw.cityId != null) {
    // signed in on the dashboard
    if (!sameSite(request)) return json({ claimed: false, error: "wrong_origin" }, 403);
    const s = await getSession(env, request, now);
    if (!s || !s.user) return json({ claimed: false, error: "sign_in" }, 401);
    const id = String(raw.cityId);
    if (!/^([0-9]{1,10}|c[0-9]{1,9})$/.test(id) || !/^[A-Z]{2}$/.test(raw.country || "")) return json({ claimed: false, error: "unknown_city" }, 404);
    return claimCore(env, { wallet: s.user.wallet, action: "claim", cityId: id, country: raw.country, location: raw.location }, now, fetchImpl, cf);
  }
  const r = await checkSigned(raw, request, now, ["claim", "add"], bad);
  if (r.error) return r.error;
  const { parsed, body } = r;
  return claimCore(env, { wallet: parsed.address, action: parsed.action, cityId: parsed.cityId, name: parsed.name, country: parsed.country, location: body.location }, now, fetchImpl, cf);
}

async function claimCore(env, { wallet, action, cityId, name, country, location }, now, fetchImpl, cf) {
  const no = (error, status = 400, extra = {}) => json({ claimed: false, error, ...extra }, status);

  if (!env.DB && !env.store) return no("claims_unavailable", 503);
  const store = storeFor(env);

  const mint = activeMint(env);
  if (!mint) return no("not_launched", 409);

  const loc = cleanLocation(location);
  if (!loc) return no("location_required");
  if (loc.accuracy > MAX_LOCATION_ACCURACY_M) return no("location_too_rough");

  let listed;
  try { listed = await countryCities(env, country); } catch { return no("cities_unavailable", 503); }
  if (!listed) return no("unknown_country");
  let bounds = null; // city boundaries are optional: without them the distance rule applies
  try { bounds = await countryBounds(env, country); } catch { /* fall back to distance */ }

  // Which city, and is the visitor inside it?
  let city;
  if (action === "claim") {
    const id = cityId;
    if (id.startsWith("c")) {
      const a = await store.addedCity(Number(id.slice(1)));
      city = a && a.country === country && { id, name: a.name, country: a.country, lat: a.lat, lon: a.lon, pop: 0 };
    } else city = listed.find((c) => c.id === id);
    if (!city) return no("unknown_city", 404);
  } else {
    const norm = normName(name);
    const same = listed.find((c) => normName(c.name) === norm && distanceKm(loc.lat, loc.lon, c.lat, c.lon) <= 60);
    const added = (await store.addedByName(country, norm)).find((c) => distanceKm(loc.lat, loc.lon, c.lat, c.lon) <= 60);
    const dup = same || (added && { id: "c" + added.id, name: added.name });
    if (dup) return no("already_listed", 409, { cityId: String(dup.id), cityName: dup.name });
    // standing inside a listed city's boundary? then that city is the one to claim
    const inside = bounds && cityAt(bounds, loc.lon, loc.lat);
    if (inside) return no("inside_listed_city", 409, { cityId: inside, cityName: listed.find((c) => c.id === inside)?.name });
    // New city center = the visitor's spot rounded to about 10 km, so no home location is revealed.
    city = { id: null, name, country, lat: Math.round(loc.lat * 10) / 10, lon: Math.round(loc.lon * 10) / 10, pop: 0 };
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
  forgetManager(city.country);
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

/** USD price from Jupiter's public price API (asked by the server, so the page loads nothing from other sites). null if unknown. */
async function tokenPrice(mint, fetchImpl) {
  try {
    const res = await fetchImpl(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const p = Number((await res.json())?.[mint]?.usdPrice);
    return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

/** Live holders: every holder from the one-minute snapshot, or the top 20 when the RPC can't list them all. */
async function holdersResponse(env, mint, fetchImpl) {
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: snap.facts.supply, total: snap.people, full: true, holders: snap.rows.slice(0, 1000), updatedAt: snap.at });
  } catch (e) {
    console.error("full holder list failed, using the top 20", String(e));
  }
  try {
    const { facts, holders } = await getTopHolders(env, mint, fetchImpl);
    return json({ launched: true, mint, supply: facts.supply, total: null, full: false, holders, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("holders failed", String(e));
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}

/** Where does a wallet stand? Read-only; the address is not stored. */
async function rankResponse(env, mint, address, fetchImpl) {
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    return json({ launched: true, full: true, address, ...rankOf(snap, address), supply: snap.facts.supply, founderMin: CLAIM_MIN_HOLD, updatedAt: snap.at });
  } catch { /* fall back to the balance alone */ }
  try {
    const amount = await getHolding(env, address, mint, fetchImpl);
    return json({ launched: true, full: false, address, amount, rank: null, total: null, founderMin: CLAIM_MIN_HOLD, updatedAt: new Date().toISOString() });
  } catch {
    return json({ launched: true, error: "chain_unavailable" }, 503);
  }
}

export async function handleApi(request, env = {}, fetchImpl = fetch) {
  const url = new URL(request.url);
  const method = request.method;
  const only = (m) => (method === m ? null : json({ error: "method_not_allowed" }, 405));
  const path = url.pathname;

  // /api/auth/google/start, /api/auth/x/callback, ...
  const oauth = path.match(/^\/api\/auth\/(google|x)\/(start|callback)$/);
  if (oauth) return only("GET") || (oauth[2] === "start" ? handleOAuthStart(request, env, oauth[1]) : handleOAuthCallback(request, env, oauth[1], fetchImpl));
  const media = path.match(/^\/api\/media\/([0-9]{1,10})$/);
  if (media) return only("GET") || handleMedia(env, media[1]);

  switch (path) {
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
        try {
          const [facts, price] = await Promise.all([getTokenFacts(env, mint, fetchImpl), tokenPrice(mint, fetchImpl)]);
          return json({ launched: true, registry: OFFICIAL.tokens, facts, price, marketCap: price && facts.supply ? price * facts.supply : null });
        }
        catch (e) { console.error("token facts failed", String(e)); return json({ launched: true, error: "chain_unavailable" }, 503); }
      });
    }
    case "/api/holders": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, holders: [] });
      return cached("holders-v2-" + mint, 60, () => holdersResponse(env, mint, fetchImpl));
    }
    case "/api/rank": {
      const blocked = only("GET");
      if (blocked) return blocked;
      const address = url.searchParams.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const mint = activeMint(env);
      if (!mint) return json({ launched: false, address, founderMin: CLAIM_MIN_HOLD });
      return rankResponse(env, mint, address, fetchImpl);
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
      else if (action === "login" && (!q.get("pin") || /^[0-9]{2}$/.test(q.get("pin")))) statement = statementFor("login", { pin: q.get("pin") || undefined });
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
    case "/api/members":
      return only("GET") || cached("members", 60, () => handleMembers(env));

    // accounts
    case "/api/auth/wallet":
      return only("POST") || handleWalletLogin(request, env);
    case "/api/auth/transfer":
      return only("POST") || handleTransferStart(request, env);
    case "/api/auth/transfer/check":
      return only("POST") || handleTransferCheck(request, env, Date.now(), fetchImpl);
    case "/api/auth/logout":
      return only("POST") || handleLogout(request, env);
    case "/api/pair":
      if (method === "POST") return handlePairStart(request, env);
      return only("GET") || handlePairStatus(request, env);
    case "/api/pair/finish":
      return only("POST") || handlePairFinish(request, env);

    // dashboard
    case "/api/me":
      return only("GET") || handleMe(request, env, fetchImpl);
    case "/api/home":
      return only("POST") || handleHome(request, env);

    // feeds
    case "/api/posts":
      if (method === "POST") return handleNewPost(request, env, fetchImpl);
      return only("GET") || handlePosts(request, env, fetchImpl);
    case "/api/posts/vote":
      return only("POST") || handleVote(request, env, fetchImpl);
    case "/api/posts/report":
      return only("POST") || handleReport(request, env, fetchImpl);
    case "/api/posts/hide":
      return only("POST") || handleHide(request, env, fetchImpl);
    case "/api/posts/ban":
      return only("POST") || handleBan(request, env, fetchImpl);
    case "/api/mod":
      return only("GET") || handleModQueue(request, env, fetchImpl);
    case "/api/requests":
      if (method === "POST") return handleNewRequest(request, env);
      return only("GET") || handleMyRequests(request, env);
    case "/api/requests/decide":
      return only("POST") || handleDecide(request, env, fetchImpl);
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
