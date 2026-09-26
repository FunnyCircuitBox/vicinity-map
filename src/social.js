/**
 * Local (your city) and national (your country) feeds: memes, check-ins and discussions,
 * weekly votes, reports, and the moderators' tools. Plus "add my town" requests that the
 * country manager approves.
 *
 * Rules, kept here in one place:
 *   - signed in, with a home community, to read or post; after launch, only holders can post and vote
 *   - 12 posts an hour at most; one check-in a day, and only from inside your community
 *   - no contract addresses in posts (the only real one is on the Token page): stops fake-token scams
 *   - votes: 1 for everyone, 2 for city founders, 3 for country managers; "top" = this week (from Monday, UTC)
 *   - 5 reports hide a post until a moderator looks at it
 *   - moderators: a city founder in their city, a country manager in their country, the admin everywhere.
 *     Founders and managers can hide posts; managers can also ban someone from their country's feeds;
 *     the admin can ban from everything.
 */
import { json, readJson, sameSite } from "./http.js";
import { getSession } from "./auth.js";
import { ensureSchema } from "./store.js";
import { CITY_NAME_RE } from "./solana.js";
import { MAX_LOCATION_ACCURACY_M, cleanLocation } from "./cities.js";
import { networkCheck } from "./network.js";
import { locate } from "./community.js";
import { FOUNDER_MIN, amountsFor, canModerate, managerOf, powersOf } from "./roles.js";
import { activeMint } from "./official.js";

const KINDS = ["meme", "checkin", "talk"];
const LIMITS = { meme: 280, checkin: 140, talk: 1000, reply: 500 };
const MAX_IMAGE = 200_000;
const POSTS_PER_HOUR = 12;
const AUTO_HIDE_REPORTS = 5;
const iso = (ms) => new Date(ms).toISOString();

/** Monday 00:00 UTC of this week: weekly votes start here. */
export function weekStart(now = Date.now()) {
  const d = new Date(now);
  const day = (d.getUTCDay() + 6) % 7;
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

/** Text as typed, minus control characters and runs of blank lines. */
export function cleanText(s, max) {
  const t = String(s || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? null : t;
}
const HAS_ADDRESS = /(^|[^1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}($|[^1-9A-HJ-NP-Za-km-z])/;

async function signedIn(request, env, now) {
  const s = await getSession(env, request, now);
  if (!s || !s.user) return { error: json({ ok: false, error: "sign_in" }, 401) };
  await ensureSchema(env.DB);
  return { u: s.user };
}
const placeFor = (u, scope) => (scope === "country" ? u.home_country : u.home_city);
/** Can this person see this post? Your city's posts, your country's posts. */
const sees = (u, p, pw) => canModerate(pw, p) || (p.scope === "city" ? p.place === u.home_city : p.place === u.home_country);

const COLS = "p.id, p.user_id, p.scope, p.place, p.country, p.kind, p.body, p.media_id, p.parent_id, p.score, p.reports, p.replies, p.hidden, p.created_at, u.handle, u.name, u.wallet, u.home_name AS author_home, c.city_name AS founder_city";
const FROM = "FROM posts p JOIN users u ON u.id = p.user_id LEFT JOIN claims c ON c.wallet = u.wallet";

/** Posts as the page sees them: author name and live role, never their wallet. */
async function present(env, rows, me, pw, fetchImpl) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const mine = new Set((await env.DB.prepare(`SELECT post_id FROM votes WHERE user_id = ? AND post_id IN (${ids.map(() => "?").join(",")})`)
    .bind(me.id, ...ids).all()).results.map((r) => r.post_id));
  // founders keep the label only while they hold 1M+ (checked live)
  const launched = Boolean(activeMint(env));
  const founders = [...new Set(rows.filter((r) => r.founder_city).map((r) => r.wallet))];
  const amounts = launched && founders.length ? await amountsFor(env, founders, fetchImpl).catch(() => new Map()) : new Map();
  const countries = [...new Set(rows.map((r) => r.country))];
  const managerWallets = new Set();
  for (const cc of countries) { const m = await managerOf(env, cc, fetchImpl).catch(() => null); if (m) managerWallets.add(m.wallet); }
  return rows.map((r) => ({
    id: r.id, kind: r.kind, body: r.body, image: r.media_id ? `/api/media/${r.media_id}` : null,
    score: r.score, replies: r.replies, at: r.created_at, hidden: Boolean(r.hidden), reports: canModerate(pw, r) ? r.reports : undefined,
    where: r.kind === "checkin" ? r.author_home : undefined,
    voted: mine.has(r.id), mine: r.user_id === me.id, canModerate: canModerate(pw, r),
    author: {
      id: canModerate(pw, r) ? r.user_id : undefined,
      name: r.handle || r.name || "Member",
      founder: r.founder_city && (amounts.get(r.wallet) || 0) >= FOUNDER_MIN ? r.founder_city : null,
      manager: managerWallets.has(r.wallet),
    },
  }));
}

/** GET /api/posts?scope=city|country&kind=meme|checkin|talk&sort=new|top&before=<id>  or  ?parent=<id> for replies */
export async function handlePosts(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await signedIn(request, env, now);
  if (m.error) return m.error;
  const u = m.u, q = new URL(request.url).searchParams;
  const pw = await powersOf(env, u, fetchImpl);
  const db = env.DB;
  let rows;
  if (q.get("parent")) {
    const par = await db.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(q.get("parent")) || 0).first();
    if (!par || !sees(u, par, pw) || (par.hidden && !canModerate(pw, par))) return json({ ok: false, error: "not_found" }, 404);
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE p.parent_id = ? AND (p.hidden = 0 OR ?) ORDER BY p.id LIMIT 100`)
      .bind(par.id, canModerate(pw, par) ? 1 : 0).all()).results;
    return json({ ok: true, posts: await present(env, rows, u, pw, fetchImpl) });
  }
  const scope = q.get("scope") === "country" ? "country" : "city";
  const kind = KINDS.includes(q.get("kind")) ? q.get("kind") : "meme";
  const place = placeFor(u, scope);
  if (!place) return json({ ok: false, error: "no_home" }, 409);
  const mod = canModerate(pw, { scope, place, country: u.home_country }) ? 1 : 0;
  // Check-ins are always local; the national tab shows every city's check-ins in the country.
  const nationalCheckins = scope === "country" && kind === "checkin";
  const where = nationalCheckins
    ? `p.country = ? AND ? <> '' AND p.kind = ? AND p.parent_id IS NULL AND (p.hidden = 0 OR ?)`
    : `p.scope = ? AND p.place = ? AND p.kind = ? AND p.parent_id IS NULL AND (p.hidden = 0 OR ?)`;
  const [a1, a2] = nationalCheckins ? [place, "x"] : [scope, place];
  if (q.get("sort") === "top") {
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} AND p.created_at >= ? ORDER BY p.score DESC, p.id DESC LIMIT 30`)
      .bind(a1, a2, kind, mod, weekStart(now)).all()).results;
  } else {
    const before = Number(q.get("before")) || 0;
    rows = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE ${where} AND (? = 0 OR p.id < ?) ORDER BY p.id DESC LIMIT 20`)
      .bind(a1, a2, kind, mod, before, before).all()).results;
  }
  return json({ ok: true, scope, kind, place, canModerate: Boolean(mod), weekStart: weekStart(now), posts: await present(env, rows, u, pw, fetchImpl) });
}

/** A meme picture: base64 of a JPEG, PNG or WebP the browser already shrank. Returns { type, bytes } or null. */
function readImage(b64) {
  if (typeof b64 !== "string" || b64.length > Math.ceil(MAX_IMAGE / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (bytes.length > MAX_IMAGE || bytes.length < 16) return null;
  const is = (...sig) => sig.every((v, i) => v == null || bytes[i] === v);
  if (is(0xff, 0xd8, 0xff)) return { type: "image/jpeg", bytes };
  if (is(0x89, 0x50, 0x4e, 0x47)) return { type: "image/png", bytes };
  if (is(0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50)) return { type: "image/webp", bytes };
  return null;
}

/**
 * POST /api/posts { scope, kind, body, image?, parent?, location? }
 * kind: meme (caption and/or picture) · checkin (from inside your community, once a day) · talk (a discussion)
 * parent: reply to a post.
 */
export async function handleNewPost(request, env, fetchImpl = fetch, now = Date.now(), cf = request.cf) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const m = await signedIn(request, env, now);
  if (m.error) return m.error;
  const u = m.u, db = env.DB;
  const body = await readJson(request, 300_000);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  if (!u.home_city) return json({ ok: false, error: "no_home" }, 409);

  const ban = await db.prepare("SELECT country FROM bans WHERE user_id = ? AND (country = '*' OR country = ?)").bind(u.id, u.home_country).first();
  if (ban) return json({ ok: false, error: "banned" }, 403);
  const pw = await powersOf(env, u, fetchImpl);
  if (pw.launched && !pw.holder && !pw.admin) return json({ ok: false, error: "holders_only" }, 403);
  const recent = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE user_id = ? AND created_at >= ?").bind(u.id, iso(now - 3600_000)).first();
  if ((recent?.n || 0) >= POSTS_PER_HOUR) return json({ ok: false, error: "slow_down" }, 429);

  let parent = null;
  if (body.parent != null) {
    parent = await db.prepare("SELECT * FROM posts WHERE id = ? AND parent_id IS NULL AND hidden = 0").bind(Number(body.parent) || 0).first();
    if (!parent || !sees(u, parent, pw)) return json({ ok: false, error: "not_found" }, 404);
  }
  const kind = parent ? "reply" : KINDS.includes(body.kind) ? body.kind : null;
  if (!kind) return json({ ok: false, error: "bad_kind" }, 400);
  const scope = parent ? parent.scope : kind === "checkin" ? "city" : body.scope === "country" ? "country" : "city";
  let text = cleanText(body.body, LIMITS[kind]);
  if (text == null) return json({ ok: false, error: "too_long", max: LIMITS[kind] }, 400);
  if (HAS_ADDRESS.test(text)) return json({ ok: false, error: "no_addresses" }, 400);
  const image = kind === "meme" && body.image != null ? readImage(body.image) : null;
  if (kind === "meme" && body.image != null && !image) return json({ ok: false, error: "bad_image" }, 400);

  if (kind === "checkin") {
    const today = iso(now).slice(0, 10);
    const already = await db.prepare("SELECT id FROM posts WHERE user_id = ? AND kind = 'checkin' AND created_at >= ?").bind(u.id, today).first();
    if (already) return json({ ok: false, error: "checked_in_today" }, 409);
    const loc = cleanLocation(body.location);
    if (!loc) return json({ ok: false, error: "location_required" }, 400);
    if (loc.accuracy > MAX_LOCATION_ACCURACY_M) return json({ ok: false, error: "location_too_rough" }, 400);
    const net = networkCheck(cf, loc, u.home_country);
    if (net) return json({ ok: false, ...net }, 403);
    const here = await locate(env, u.home_country, loc.lon, loc.lat).catch(() => null);
    if (!here || !here.city || here.city.id !== u.home_city) return json({ ok: false, error: "not_in_city", here: here?.city?.name || null }, 403);
    if (!text) text = `Checked in to ${u.home_name}`;
  }
  if (!text && !image) return json({ ok: false, error: "empty" }, 400);

  const place = parent ? parent.place : placeFor(u, scope);
  const country = parent ? parent.country : u.home_country;
  let mediaId = null;
  if (image) {
    const r = await db.prepare("INSERT INTO media (user_id, type, bytes, created_at) VALUES (?, ?, ?, ?)").bind(u.id, image.type, image.bytes, iso(now)).run();
    mediaId = r.meta.last_row_id;
  }
  const ins = await db.prepare("INSERT INTO posts (user_id, scope, place, country, kind, body, media_id, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, scope, place, country, kind, text, mediaId, parent ? parent.id : null, iso(now)).run();
  if (parent) await db.prepare("UPDATE posts SET replies = replies + 1 WHERE id = ?").bind(parent.id).run();
  const row = await db.prepare(`SELECT ${COLS} ${FROM} WHERE p.id = ?`).bind(ins.meta.last_row_id).first();
  return json({ ok: true, post: (await present(env, [row], u, pw, fetchImpl))[0] });
}

async function postFor(request, env, now, fetchImpl) {
  if (!sameSite(request)) return { error: json({ ok: false, error: "wrong_origin" }, 403) };
  const m = await signedIn(request, env, now);
  if (m.error) return m;
  const body = await readJson(request);
  if (!body) return { error: json({ ok: false, error: "bad_json" }, 400) };
  const post = await env.DB.prepare("SELECT * FROM posts WHERE id = ?").bind(Number(body.id) || 0).first();
  const pw = await powersOf(env, m.u, fetchImpl);
  if (!post || !sees(m.u, post, pw)) return { error: json({ ok: false, error: "not_found" }, 404) };
  return { u: m.u, body, post, pw };
}

/** POST /api/posts/vote { id } → vote, or take your vote back. Founders count 2, managers 3. */
export async function handleVote(request, env, fetchImpl = fetch, now = Date.now()) {
  const r = await postFor(request, env, now, fetchImpl);
  if (r.error) return r.error;
  const { u, post, pw } = r, db = env.DB;
  if (post.hidden) return json({ ok: false, error: "not_found" }, 404);
  if (post.user_id === u.id) return json({ ok: false, error: "own_post" }, 400);
  if (pw.launched && !pw.holder && !pw.admin) return json({ ok: false, error: "holders_only" }, 403);
  const had = await db.prepare("SELECT weight FROM votes WHERE post_id = ? AND user_id = ?").bind(post.id, u.id).first();
  if (had) {
    await db.batch([
      db.prepare("DELETE FROM votes WHERE post_id = ? AND user_id = ?").bind(post.id, u.id),
      db.prepare("UPDATE posts SET score = score - ? WHERE id = ?").bind(had.weight, post.id),
    ]);
  } else {
    await db.batch([
      db.prepare("INSERT INTO votes (post_id, user_id, weight, created_at) VALUES (?, ?, ?, ?)").bind(post.id, u.id, pw.weight, iso(now)),
      db.prepare("UPDATE posts SET score = score + ? WHERE id = ?").bind(pw.weight, post.id),
    ]);
  }
  const s = await db.prepare("SELECT score FROM posts WHERE id = ?").bind(post.id).first();
  return json({ ok: true, voted: !had, score: s.score, weight: pw.weight });
}

/** POST /api/posts/report { id, reason } → five reports hide a post until a moderator looks. */
export async function handleReport(request, env, fetchImpl = fetch, now = Date.now()) {
  const r = await postFor(request, env, now, fetchImpl);
  if (r.error) return r.error;
  const { u, post, body } = r, db = env.DB;
  if (post.user_id === u.id) return json({ ok: false, error: "own_post" }, 400);
  const reason = cleanText(body.reason, 140) || null;
  const ins = await db.prepare("INSERT OR IGNORE INTO reports (post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)").bind(post.id, u.id, reason, iso(now)).run();
  if (ins.meta.changes) {
    await db.prepare("UPDATE posts SET reports = reports + 1, hidden = CASE WHEN reports + 1 >= ? THEN 1 ELSE hidden END WHERE id = ?").bind(AUTO_HIDE_REPORTS, post.id).run();
  }
  return json({ ok: true });
}

/** POST /api/posts/hide { id, hidden } → moderators only. */
export async function handleHide(request, env, fetchImpl = fetch, now = Date.now()) {
  const r = await postFor(request, env, now, fetchImpl);
  if (r.error) return r.error;
  if (!canModerate(r.pw, r.post)) return json({ ok: false, error: "not_allowed" }, 403);
  const hidden = r.body.hidden === false ? 0 : 1;
  await env.DB.prepare("UPDATE posts SET hidden = ?, reports = CASE WHEN ? = 0 THEN 0 ELSE reports END WHERE id = ?").bind(hidden, hidden, r.post.id).run();
  return json({ ok: true, hidden: Boolean(hidden) });
}

/** POST /api/posts/ban { id, reason } → ban the post's author: a manager from their country's feeds, the admin from everything. */
export async function handleBan(request, env, fetchImpl = fetch, now = Date.now()) {
  const r = await postFor(request, env, now, fetchImpl);
  if (r.error) return r.error;
  const { u, post, pw, body } = r;
  const where = pw.admin ? "*" : pw.managerCountry && post.country === pw.managerCountry ? pw.managerCountry : null;
  if (!where) return json({ ok: false, error: "not_allowed" }, 403);
  if (post.user_id === u.id) return json({ ok: false, error: "own_post" }, 400);
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO bans (user_id, country, by_user, reason, created_at) VALUES (?, ?, ?, ?, ?)").bind(post.user_id, where, u.id, cleanText(body.reason, 140) || null, iso(now)),
    env.DB.prepare("UPDATE posts SET hidden = 1 WHERE id = ?").bind(post.id),
  ]);
  return json({ ok: true, banned: where });
}

/** GET /api/mod → the moderator's to-do list: reported posts and "add my town" requests in their area. */
export async function handleModQueue(request, env, fetchImpl = fetch, now = Date.now()) {
  const m = await signedIn(request, env, now);
  if (m.error) return m.error;
  const pw = await powersOf(env, m.u, fetchImpl);
  if (!pw.admin && !pw.managerCountry && !pw.founderCity) return json({ ok: true, moderator: false, posts: [], requests: [] });
  const db = env.DB;
  const [scopeSql, scopeArgs] = pw.admin ? ["1 = 1", []]
    : pw.managerCountry ? ["p.country = ?", [pw.managerCountry]]
    : ["p.scope = 'city' AND p.place = ?", [pw.founderCity]];
  const posts = (await db.prepare(`SELECT ${COLS} ${FROM} WHERE p.reports > 0 AND ${scopeSql} ORDER BY p.reports DESC, p.id DESC LIMIT 50`).bind(...scopeArgs).all()).results;
  const reqs = pw.admin || pw.managerCountry
    ? (await db.prepare(`SELECT r.id, r.name, r.country, r.near, r.status, r.created_at, u.handle, u.name AS by_name FROM requests r JOIN users u ON u.id = r.user_id
        WHERE r.status = 'waiting' AND (? = '*' OR r.country = ?) ORDER BY r.id LIMIT 100`).bind(pw.admin ? "*" : pw.managerCountry, pw.managerCountry || "").all()).results
    : [];
  return json({ ok: true, moderator: true, scope: pw.admin ? "everywhere" : pw.managerCountry ? `country ${pw.managerCountry}` : `city ${pw.claim?.city_name}`,
    posts: await present(env, posts, m.u, pw, fetchImpl),
    requests: reqs.map((x) => ({ id: x.id, name: x.name, country: x.country, near: x.near, at: x.created_at, by: x.handle || x.by_name })) });
}

/** GET /api/media/:id → a meme picture. */
export async function handleMedia(env, id) {
  if (!env.DB || !/^[0-9]{1,10}$/.test(id)) return json({ error: "not_found" }, 404);
  await ensureSchema(env.DB);
  const row = await env.DB.prepare("SELECT type, bytes FROM media WHERE id = ?").bind(Number(id)).first();
  if (!row) return json({ error: "not_found" }, 404);
  const bytes = row.bytes instanceof ArrayBuffer ? new Uint8Array(row.bytes) : Array.isArray(row.bytes) ? Uint8Array.from(row.bytes) : row.bytes;
  return new Response(bytes, { headers: {
    "Content-Type": row.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox", "Content-Disposition": "inline",
  } });
}

/* ---------------- "add my town" requests ---------------- */

/** POST /api/requests { name, location } → ask your country manager to make your town a community. You must be there. */
export async function handleNewRequest(request, env, now = Date.now(), cf = request.cf) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const m = await signedIn(request, env, now);
  if (m.error) return m.error;
  const u = m.u, db = env.DB;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const name = String(body.name || "").trim().replace(/\s+/g, " ");
  if (!CITY_NAME_RE.test(name)) return json({ ok: false, error: "bad_name" }, 400);
  const loc = cleanLocation(body.location);
  if (!loc) return json({ ok: false, error: "location_required" }, 400);
  if (loc.accuracy > MAX_LOCATION_ACCURACY_M) return json({ ok: false, error: "location_too_rough" }, 400);
  const cc = (cf && /^[A-Z]{2}$/.test(cf.country || "") && cf.country) || u.home_country;
  if (!cc) return json({ ok: false, error: "unknown_country" }, 400);
  const net = networkCheck(cf, loc, cc);
  if (net) return json({ ok: false, ...net }, 403);
  const open = await db.prepare("SELECT id FROM requests WHERE user_id = ? AND status = 'waiting'").bind(u.id).first();
  if (open) return json({ ok: false, error: "one_at_a_time" }, 409);
  const here = await locate(env, cc, loc.lon, loc.lat).catch(() => null);
  const near = here ? (here.city ? `inside ${here.city.name}` : here.nearby[0] ? `${here.nearby[0].km} km from ${here.nearby[0].name}` : null) : null;
  const round = (v) => Math.round(v * 20) / 20; // about 5 km
  const ins = await db.prepare("INSERT INTO requests (user_id, name, country, lat, lon, near, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(u.id, name, cc, round(loc.lat), round(loc.lon), near, iso(now)).run();
  return json({ ok: true, request: { id: ins.meta.last_row_id, name, country: cc, near, status: "waiting" } });
}

/** GET /api/requests → your own requests and what happened to them. */
export async function handleMyRequests(request, env, now = Date.now()) {
  const m = await signedIn(request, env, now);
  if (m.error) return m.error;
  const rows = (await env.DB.prepare("SELECT id, name, country, near, status, note, created_at, decided_at FROM requests WHERE user_id = ? ORDER BY id DESC LIMIT 10").bind(m.u.id).all()).results;
  return json({ ok: true, requests: rows });
}

/** POST /api/requests/decide { id, approve, note } → the country manager (or the admin) decides. */
export async function handleDecide(request, env, fetchImpl = fetch, now = Date.now()) {
  if (!sameSite(request)) return json({ ok: false, error: "wrong_origin" }, 403);
  const m = await signedIn(request, env, now);
  if (m.error) return m.error;
  const body = await readJson(request);
  if (!body) return json({ ok: false, error: "bad_json" }, 400);
  const req = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(Number(body.id) || 0).first();
  if (!req) return json({ ok: false, error: "not_found" }, 404);
  const pw = await powersOf(env, m.u, fetchImpl);
  if (!pw.admin && pw.managerCountry !== req.country) return json({ ok: false, error: "not_allowed" }, 403);
  if (req.status !== "waiting") return json({ ok: false, error: "already_decided" }, 409);
  const status = body.approve ? "approved" : "declined";
  await env.DB.prepare("UPDATE requests SET status = ?, decided_by = ?, note = ?, decided_at = ? WHERE id = ?")
    .bind(status, m.u.id, cleanText(body.note, 200) || null, iso(now), req.id).run();
  return json({ ok: true, status });
}
