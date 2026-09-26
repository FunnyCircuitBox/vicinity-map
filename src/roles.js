/**
 * Roles, checked live against the blockchain (a sale takes a role away on the next check):
 *   Admin            → a wallet in the ADMIN_WALLETS setting (Cloudflare → Settings → Variables)
 *   Country manager  → the city founder in a country holding the most $VICINITY
 *   City founder     → claimed a city and still holds 1,000,000+ $VICINITY
 *   Holder           → holds any $VICINITY
 *   Member           → signed in, not holding (yet)
 */
import { OFFICIAL, activeMint } from "./official.js";
import { CLAIM_MIN_HOLD } from "./cities.js";
import { getHoldings, holderSnapshot } from "./chain.js";
import { isSolanaAddress } from "./solana.js";
import { storeFor } from "./store.js";

export const FOUNDER_MIN = CLAIM_MIN_HOLD;
export const WHALE_MIN = 10_000_000;
/** Weekly votes: founders and country managers have stronger votes (their "special voting rights"). */
export const VOTE_WEIGHT = { member: 1, holder: 1, founder: 2, manager: 3, admin: 1 };

export const adminWallets = (env) => String((env && env.ADMIN_WALLETS) || "").split(/[\s,]+/).filter(isSolanaAddress);

/**
 * Live $VICINITY amounts for some wallets: from the one-minute holder snapshot when the RPC allows it,
 * otherwise a direct lookup (only for short lists). Before launch everyone holds 0.
 */
export async function amountsFor(env, wallets, fetchImpl = fetch, { maxDirect = 200 } = {}) {
  const mint = activeMint(env);
  const out = new Map();
  if (!mint || !wallets.length) return out;
  try {
    const snap = await holderSnapshot(env, mint, fetchImpl);
    for (const w of wallets) out.set(w, snap.byOwner.get(w)?.amount || 0);
    return out;
  } catch {
    if (wallets.length > maxDirect) return out;
    return getHoldings(env, wallets, mint, fetchImpl);
  }
}

/**
 * A country's manager: { wallet, city, cityId, amount, founders } or null. Team wallets can't be managers.
 * Kept for two minutes per server.
 */
const managers = new Map();
export function managerOf(env, cc, fetchImpl = fetch) {
  const key = cc + "|" + (activeMint(env) || "none");
  const hit = managers.get(key);
  if (hit && Date.now() - hit.at < 120_000) return hit.promise;
  const promise = (async () => {
    if (!activeMint(env) || (!env.DB && !env.store)) return null;
    const team = new Set(OFFICIAL.teamWallets || []);
    const founders = (await storeFor(env).claimsByCountry(cc)).filter((f) => !team.has(f.wallet));
    if (!founders.length) return null;
    const amounts = await amountsFor(env, founders.map((f) => f.wallet), fetchImpl);
    let best = null;
    for (const f of founders) {
      const amount = amounts.get(f.wallet) || 0;
      if (amount > 0 && (!best || amount > best.amount)) best = { wallet: f.wallet, city: f.city_name, cityId: f.city_id, amount };
    }
    return best && { ...best, founders: founders.length };
  })();
  managers.set(key, { at: Date.now(), promise });
  promise.catch(() => managers.delete(key));
  return promise;
}
export const _resetRoles = () => managers.clear();
/** A new founder in a country: work its manager out again on the next look. */
export const forgetManager = (cc) => { for (const k of managers.keys()) if (k.startsWith(cc + "|")) managers.delete(k); };

/**
 * Everything a person may do, from live data: { admin, holder, amount, founderCity, founderCountry, managerCountry, level, weight }.
 */
export async function powersOf(env, user, fetchImpl = fetch) {
  const launched = Boolean(activeMint(env));
  const admin = adminWallets(env).includes(user.wallet);
  const amount = launched ? (await amountsFor(env, [user.wallet], fetchImpl)).get(user.wallet) || 0 : 0;
  const claim = await storeFor(env).claimByWallet(user.wallet);
  const founder = Boolean(claim && launched && amount >= FOUNDER_MIN);
  let managerCountry = null;
  if (founder) {
    const m = await managerOf(env, claim.country, fetchImpl).catch(() => null);
    if (m && m.wallet === user.wallet) managerCountry = claim.country;
  }
  const level = admin ? "admin" : managerCountry ? "manager" : founder ? "founder" : amount > 0 ? "holder" : "member";
  return {
    admin, launched, amount, holder: amount > 0, claim,
    founderCity: founder ? claim.city_id : null, founderCountry: founder ? claim.country : null,
    managerCountry, level, weight: VOTE_WEIGHT[managerCountry ? "manager" : founder ? "founder" : "member"],
  };
}

/** May these powers moderate this post? Admin anywhere, a manager in their country, a founder in their city. */
export const canModerate = (p, post) =>
  Boolean(p.admin || (p.managerCountry && post.country === p.managerCountry) || (p.founderCity && post.scope === "city" && post.place === p.founderCity));
