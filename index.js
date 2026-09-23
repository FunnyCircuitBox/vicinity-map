/**
 * Vicinity Map — backend (Cloudflare Worker).
 *
 * Milestone 1: only a health-check endpoint. Everything else is served
 * from the /public folder by Cloudflare's static asset handler.
 *
 * No secrets, no wallets, no database yet.
 */

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self)",
};

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export async function handleApi(request) {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    return json({ ok: true, service: "vicinity-map", milestone: 1 });
  }

  return json({ error: "not_found" }, 404);
}

export function withSecurityHeaders(response) {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
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
