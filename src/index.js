/**
 * Vicinity — backend (Cloudflare Worker).
 *
 * API:
 *   GET  /api/health          → is the backend up?
 *   GET  /api/official        → the official links list
 *   GET  /api/check?q=...     → "is this link / address / handle official?"
 *   GET  /api/message?address → the exact text a wallet signs to verify ownership
 *   POST /api/verify          → check a signed message from a Solana wallet
 *
 * Everything else is served from /public by Cloudflare's static asset handler.
 * No database, no secrets, no stored wallet addresses.
 */
import { OFFICIAL, checkOfficial } from "./official.js";
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

export async function handleVerify(request, now = Date.now()) {
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
  return json({ verified: true, address, verifiedAt: new Date(now).toISOString() });
}

export async function handleApi(request) {
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
      return only("POST") || handleVerify(request);
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
      if (url.pathname.startsWith("/api/")) return await handleApi(request);
      return withSecurityHeaders(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error("Unhandled error:", err && err.stack ? err.stack : err);
      return json({ error: "internal_error" }, 500);
    }
  },
};
