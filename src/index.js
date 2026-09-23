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
 *
 * Everything else is served from /public by Cloudflare's static asset handler.
 * No database and no stored wallet addresses. Optional secret: SOLANA_RPC_URL.
 */
import { OFFICIAL, VICINITY_MINT, checkOfficial } from "./official.js";
import { getHolding, getTokenFacts, getTopHolders } from "./chain.js";
import { base58Encode, buildMessage, isSolanaAddress, parseMessage, verifySignature } from "./solana.js";

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

export async function handleVerify(request, env = {}, now = Date.now(), fetchImpl = fetch) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_BODY) return json({ verified: false, error: "too_large" }, 413);
  let body;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ verified: false, error: "too_large" }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ verified: false, error: "bad_json" }, 400);
  }
  const { address, message, signature } = body || {};
  if (!isSolanaAddress(address)) return json({ verified: false, error: "bad_address" }, 400);

  const parsed = parseMessage(message);
  if (!parsed) return json({ verified: false, error: "bad_message" }, 400);

  const host = new URL(request.url).host;
  if (parsed.host !== host) return json({ verified: false, error: "wrong_site" }, 400);
  if (parsed.address !== address) return json({ verified: false, error: "address_mismatch" }, 400);

  const issued = Date.parse(parsed.issuedAt);
  if (!Number.isFinite(issued) || issued > now + 60_000 || now - issued > MAX_AGE_MS)
    return json({ verified: false, error: "expired" }, 400);

  let sig;
  try { sig = base64ToBytes(signature); } catch { return json({ verified: false, error: "bad_signature" }, 400); }

  let ok = false;
  try { ok = await verifySignature(address, message, sig); } catch { ok = false; }
  if (!ok) return json({ verified: false, error: "signature_mismatch" }, 401);

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
    } catch (e) {
      console.error("holding lookup failed", String(e));
      out.holderCheck = "unavailable";
    }
  }
  return json(out);
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
      const address = url.searchParams.get("address");
      if (!isSolanaAddress(address)) return json({ error: "bad_address" }, 400);
      const nonce = base58Encode(crypto.getRandomValues(new Uint8Array(16)));
      const issuedAt = new Date().toISOString();
      return json({ message: buildMessage({ host: url.host, address, nonce, issuedAt }) });
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
