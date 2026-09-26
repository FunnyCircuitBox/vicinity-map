/**
 * The dashboard's data, recomputed from live blockchain data on every call (the page asks
 * every minute). Sell below a line and the badge or role that needs it is gone on the next check.
 *
 *   GET  /api/me          → who you are, your live position, roles, badges, city + claim progress
 *   GET  /api/me?lite=1   → just who you are (for the header on every page)
 *   POST /api/home        → set your home community from where you are (location used once, never saved)
 */
import { json, readJson, sameSite } from "./http.js";
import { getSession, providers } from "./auth.js";
import { activeMint } from "./official.js";
import { getHolding, holderSnapshot, rankOf } from "./chain.js";
import { FOUNDER_MIN, WHALE_MIN, VOTE_WEIGHT, adminWallets, amountsFor, managerOf } from "./roles.js";
import { ensureSchema, storeFor } from "./store.js";
import { MAX_LOCATION_ACCURACY_M, cleanLocation } from "./cities.js";
import { communityById, locate } from "./community.js";
import { networkCheck } from "./network.js";

const HOME_LOCK_DAYS = 7; // a home community can be changed once a week
const mask = (w) => (w ? `${w.slice(0, 5)}*****${w.slice(-3)}` : null);
const iso = (ms) => new Date(ms).toISOString();

export const publicUser = (u) => ({
  id: u.id, wallet: u.wallet, provider: u.provider, handle: u.handle, name: u.name,
  home: u.home_city ? { id: u.home_city, name: u.home_name, country: u.home_country, since: u.home_at } : null,
  joined: u.created_at,
});

/** Badges that depend on holding: these can be lost by selling. */
const HOLDING_BADGES = new Set(["holder", "founder_ready", "whale", "top100", "top10", "city_founder", "country_manager"]);

function badgesFor({ u, launched, amount, position, founder, manager, admin, checkins, posts }) {
  const pct = (v, of) => Math.max(0, Math.min(1, v / of));
  const list = [
    { id: "early", icon: "🌱", name: "Early member", detail: "Joined before $VICINITY launched. This one can never be earned again.", earned: Boolean(u.early) },
    { id: "verified", icon: "✅", name: "Verified human", detail: "One wallet + one X or Google login.", earned: true },
    { id: "local", icon: "📍", name: "Local", detail: "Home community confirmed by location.", earned: Boolean(u.home_city) },
    { id: "holder", icon: "🏅", name: "Founding Supporter", detail: launched ? "Hold any $VICINITY." : "Hold $VICINITY once it launches.", earned: amount > 0, progress: amount > 0 ? 1 : 0 },
    { id: "founder_ready", icon: "🔑", name: "Founder-ready", detail: `Hold ${FOUNDER_MIN.toLocaleString("en-US")}+ $VICINITY: enough to claim a city.`, earned: amount >= FOUNDER_MIN, progress: pct(amount, FOUNDER_MIN) },
    { id: "whale", icon: "🐋", name: "Whale", detail: `Hold ${WHALE_MIN.toLocaleString("en-US")}+ $VICINITY.`, earned: amount >= WHALE_MIN, progress: pct(amount, WHALE_MIN) },
    { id: "top100", icon: "💯", name: "Top 100", detail: "One of the 100 biggest holders (pools not counted).", earned: Boolean(position?.rank && position.rank <= 100) },
    { id: "top10", icon: "🏆", name: "Top 10", detail: "One of the 10 biggest holders.", earned: Boolean(position?.rank && position.rank <= 10) },
    { id: "city_founder", icon: "👑", name: "City Founder", detail: `Claimed a city and holds ${FOUNDER_MIN.toLocaleString("en-US")}+ $VICINITY.`, earned: founder },
    { id: "country_manager", icon: "🛡️", name: "Country Manager", detail: "The city founder holding the most $VICINITY in a country.", earned: manager },
    { id: "voice", icon: "💬", name: "Local voice", detail: "Posted in your city or country feed.", earned: posts > 0 },
    { id: "streak", icon: "🔥", name: "On the streets", detail: "Checked in on 3 different days.", earned: checkins >= 3, progress: pct(checkins, 3) },
  ];
  if (admin) list.unshift({ id: "admin", icon: "⚙️", name: "Admin", detail: "Runs Vicinity.", earned: true });
  return list;
}

async function liveStatus(env, u, fetchImpl, now) {
  const mint = activeMint(env), launched = Boolean(mint), wallet = u.wallet;
  let snap = null, chain = launched ? "live" : "prelaunch";
  if (launched) { try { snap = await holderSnapshot(env, mint, fetchImpl); } catch { chain = "partial"; } }
  let amount = 0, position = null;
  if (snap) { position = rankOf(snap, wallet); amount = position.amount; }
  else if (launched) { try { amount = await getHolding(env, wallet, mint, fetchImpl); } catch { chain = "unavailable"; } }

  const store = storeFor(env);
  const admin = adminWallets(env).includes(wallet);
  const claim = await store.claimByWallet(wallet);
  const founder = Boolean(claim && launched && amount >= FOUNDER_MIN);
  const cc = u.home_country || (claim && claim.country) || null;
  const manager = cc ? await managerOf(env, cc, fetchImpl).catch(() => null) : null;
  const ownManager = founder ? await managerOf(env, claim.country, fetchImpl).catch(() => null) : null;
  const isManager = Boolean(ownManager && ownManager.wallet === wallet);
  const level = admin ? "admin" : isManager ? "manager" : founder ? "founder" : amount > 0 ? "holder" : "member";

  // your community and your country: members, founder, where you rank among them
  const db = env.DB;
  const ranked = async (wallets) => {
    if (!launched || !snap) return { rank: null, holders: null, top: [] };
    const amounts = await amountsFor(env, wallets, fetchImpl);
    const list = wallets.map((w) => [w, amounts.get(w) || 0]).filter(([, a]) => a > 0).sort((a, b) => b[1] - a[1]);
    const i = list.findIndex(([w]) => w === wallet);
    return { rank: i >= 0 ? i + 1 : null, holders: list.length, top: list.slice(0, 5).map(([w, a]) => ({ wallet: mask(w), amount: a, you: w === wallet })) };
  };
  let community = null, national = null;
  if (u.home_city) {
    const members = (await db.prepare("SELECT wallet FROM users WHERE home_city = ? LIMIT 5000").bind(u.home_city).all()).results.map((r) => r.wallet);
    const cityClaim = await store.claimByCity(u.home_city);
    community = { id: u.home_city, name: u.home_name, country: u.home_country, members: members.length,
      founder: cityClaim ? { wallet: mask(cityClaim.wallet), since: cityClaim.claimed_at, you: cityClaim.wallet === wallet } : null,
      ...(await ranked(members)) };
  }
  if (cc) {
    const members = (await db.prepare("SELECT wallet FROM users WHERE home_country = ? LIMIT 20000").bind(cc).all()).results.map((r) => r.wallet);
    national = { country: cc, members: members.length, ...(await ranked(members)),
      manager: manager ? { wallet: mask(manager.wallet), city: manager.city, amount: manager.amount, you: manager.wallet === wallet } : null };
  }

  // activity (for the "voice" and "streak" badges)
  const act = await db.prepare(
    "SELECT COUNT(*) AS posts, COUNT(DISTINCT CASE WHEN kind = 'checkin' THEN substr(created_at, 1, 10) END) AS days FROM posts WHERE user_id = ? AND hidden = 0",
  ).bind(u.id).first();

  const badges = badgesFor({ u, launched, amount, position, founder, manager: isManager, admin, checkins: act?.days || 0, posts: act?.posts || 0 });
  const earned = badges.filter((b) => b.earned).map((b) => b.id);
  let lost = [];
  try { lost = JSON.parse(u.badges || "[]").filter((id) => HOLDING_BADGES.has(id) && !earned.includes(id)); } catch {}
  if (JSON.stringify(earned) !== (u.badges || "")) {
    await db.prepare("UPDATE users SET badges = ? WHERE id = ?").bind(JSON.stringify(earned), u.id).run();
  }

  // progress towards founding your home city
  const homeClaim = community && community.founder;
  const steps = [
    { id: "wallet", label: "Wallet verified", done: true },
    { id: "account", label: `${u.provider === "x" ? "X" : "Google"} account linked`, done: true },
    { id: "home", label: u.home_city ? `Home community: ${u.home_name}` : "Set your home community", done: Boolean(u.home_city) },
    { id: "hold", label: `Hold ${FOUNDER_MIN.toLocaleString("en-US")} $VICINITY`, done: amount >= FOUNDER_MIN,
      progress: Math.min(1, amount / FOUNDER_MIN), detail: launched ? `${Math.floor(amount).toLocaleString("en-US")} / ${FOUNDER_MIN.toLocaleString("en-US")}` : "Opens at launch" },
    { id: "open", label: homeClaim ? (homeClaim.you ? "The city is yours" : "Someone founded it first") : "City still open", done: Boolean(!homeClaim || homeClaim.you), blocked: Boolean(homeClaim && !homeClaim.you) },
    { id: "claim", label: claim ? `Founded ${claim.city_name}` : "Stand in the city and claim it", done: Boolean(claim) },
  ];
  const done = steps.filter((s) => s.done).length;

  return {
    launched, chain, checkedAt: iso(now), level,
    roles: { admin, manager: isManager, founder, holder: amount > 0, weight: VOTE_WEIGHT[level] || 1 },
    holding: { amount, rank: position ? position.rank : null, total: position ? position.total : null, percent: position ? position.percent : null,
      percentile: position ? position.percentile : null, next: position ? position.next : null, founderGap: Math.max(0, FOUNDER_MIN - amount) },
    claim: claim ? { cityId: claim.city_id, cityName: claim.city_name, country: claim.country, since: claim.claimed_at, active: founder, atRisk: launched && !founder } : null,
    badges, lost, community, national,
    progress: { percent: Math.round((done / steps.length) * 100), steps, claimable: launched && Boolean(u.home_city) && amount >= FOUNDER_MIN && !claim && !homeClaim },
  };
}

export async function handleMe(request, env, fetchImpl = fetch, now = Date.now()) {
  const s = await getSession(env, request, now);
  const prov = providers(env);
  if (!s) return json({ signedIn: false, providers: prov });
  if (!s.user) {
    let proof = null;
    try { if (s.proof) { const p = JSON.parse(s.proof); proof = { address: p.address, lamports: p.lamports, sol: (p.lamports / 1e9).toFixed(6) }; } } catch {}
    return json({ signedIn: false, providers: prov, pending: s.wallet ? { wallet: s.wallet } : null, proof });
  }
  const user = publicUser(s.user);
  if (new URL(request.url).searchParams.get("lite") === "1") return json({ signedIn: true, user, providers: prov });
  return json({ signedIn: true, user, providers: prov, ...(await liveStatus(env, s.user, fetchImpl, now)) });
}

/**
 * POST /api/home { location: { lat, lon, accuracy }, choice?, country? }
 * Inside a community → that's home. In empty land → pick one of the three nearest (send `choice`).
 * The location is used for this one check and never saved; only the community is.
 */
export async function handleHome(request, env, now = Date.now(), cf = request.cf) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const s = await getSession(env, request, now);
  if (!s || !s.user) return json({ ok: false, error: "sign_in" }, 401);
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const u = s.user;
  if (u.home_at && now - Date.parse(u.home_at) < HOME_LOCK_DAYS * 86400_000) {
    return json({ ok: false, error: "home_locked", until: iso(Date.parse(u.home_at) + HOME_LOCK_DAYS * 86400_000) }, 409);
  }
  const loc = cleanLocation(body.location);
  if (!loc) return json({ ok: false, error: "location_required" }, 400);
  if (loc.accuracy > MAX_LOCATION_ACCURACY_M) return json({ ok: false, error: "location_too_rough" }, 400);
  // The country comes from the internet connection (Cloudflare); tests and local runs may pass it.
  const cc = (cf && /^[A-Z]{2}$/.test(cf.country || "") && cf.country) || (/^[A-Z]{2}$/.test(body.country || "") ? body.country : null);
  if (!cc) return json({ ok: false, error: "unknown_country" }, 400);
  const net = networkCheck(cf, loc, cc);
  if (net) return json({ ok: false, ...net }, 403);

  let found;
  try { found = await locate(env, cc, loc.lon, loc.lat); } catch { return json({ ok: false, error: "cities_unavailable" }, 503); }
  if (!found) return json({ ok: false, error: "unknown_country" }, 400);
  let home = found.city;
  if (!home) {
    const pick = body.choice != null && found.nearby.find((c) => c.id === String(body.choice));
    if (!pick) return json({ ok: false, needsChoice: true, nearby: found.nearby });
    home = await communityById(env, cc, pick.id);
  }
  await ensureSchema(env.DB);
  await env.DB.prepare("UPDATE users SET home_city = ?, home_name = ?, home_country = ?, home_at = ? WHERE id = ?")
    .bind(home.id, home.name, home.country, iso(now), u.id).run();
  return json({ ok: true, home: { id: home.id, name: home.name, country: home.country }, joinedNearby: !found.city });
}

/** GET /api/members → how many people call each community home (public, no names or wallets). */
export async function handleMembers(env) {
  if (!env.DB) return json({ members: 0, communities: [] });
  await ensureSchema(env.DB);
  const [total, top] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM users"),
    env.DB.prepare("SELECT home_city AS id, home_name AS name, home_country AS country, COUNT(*) AS members FROM users WHERE home_city IS NOT NULL GROUP BY home_city ORDER BY members DESC LIMIT 300"),
  ]);
  return json({ members: total.results[0]?.n || 0, communities: top.results });
}
