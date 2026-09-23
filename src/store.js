/**
 * City claims database (Cloudflare D1, binding name "DB").
 *
 * What is saved, and nothing more:
 *   claims       → which wallet claimed which city, and when (public on the site)
 *   added_cities → cities the community added: name, country, approximate center
 *                  (rounded to ~10 km), which wallet added it
 * Locations of visitors are never saved. Wallets that only "verify" are never saved.
 *
 * The UNIQUE rules in the database itself enforce: one wallet ↔ one city.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  city_id    TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL UNIQUE,
  city_name  TEXT NOT NULL,
  country    TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS added_cities (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  norm       TEXT NOT NULL,
  country    TEXT NOT NULL,
  lat        REAL NOT NULL,
  lon        REAL NOT NULL,
  added_by   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS added_by_country ON added_cities (country, norm);
`;

let schemaReady = null;
/** Create the tables the first time they're needed ("IF NOT EXISTS" makes this safe to repeat). */
function ensureSchema(db) {
  if (!schemaReady) {
    const stmts = SCHEMA.split(";").map((s) => s.trim()).filter(Boolean).map((s) => db.prepare(s));
    schemaReady = db.batch(stmts).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/** D1-backed store. Every function the API needs, in one place. */
export function d1Store(db) {
  const api = {
    async claimByWallet(wallet) {
      return db.prepare("SELECT city_id, city_name, country, claimed_at FROM claims WHERE wallet = ?").bind(wallet).first();
    },
    async claimByCity(cityId) {
      return db.prepare("SELECT wallet, claimed_at FROM claims WHERE city_id = ?").bind(cityId).first();
    },
    async addedCity(id) {
      return db.prepare("SELECT id, name, country, lat, lon FROM added_cities WHERE id = ? AND hidden = 0").bind(id).first();
    },
    async addedByName(country, norm) {
      const { results } = await db.prepare("SELECT id, name, country, lat, lon FROM added_cities WHERE country = ? AND norm = ? AND hidden = 0").bind(country, norm).all();
      return results;
    },
    async insertClaim({ cityId, wallet, cityName, country, at }) {
      await db.prepare("INSERT INTO claims (city_id, wallet, city_name, country, claimed_at) VALUES (?, ?, ?, ?, ?)")
        .bind(cityId, wallet, cityName, country, at).run();
    },
    /** Add a city and claim it in one all-or-nothing step. Returns the new city id ("c<number>"). */
    async insertAddedCityAndClaim({ name, norm, country, lat, lon, wallet, at }) {
      const [ins] = await db.batch([
        db.prepare("INSERT INTO added_cities (name, norm, country, lat, lon, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .bind(name, norm, country, lat, lon, wallet, at),
        db.prepare("INSERT INTO claims (city_id, wallet, city_name, country, claimed_at) VALUES ('c' || last_insert_rowid(), ?, ?, ?, ?)")
          .bind(wallet, name, country, at),
      ]);
      return "c" + ins.meta.last_row_id;
    },
    async listAll() {
      const [claims, added] = await db.batch([
        db.prepare("SELECT city_id, wallet, city_name, country, claimed_at FROM claims ORDER BY claimed_at DESC"),
        db.prepare("SELECT id, name, country, lat, lon FROM added_cities WHERE hidden = 0 ORDER BY id"),
      ]);
      return { claims: claims.results, added: added.results.map((c) => ({ ...c, id: "c" + c.id })) };
    },
  };
  // Every call makes sure the tables exist first (only really runs once per worker instance).
  return Object.fromEntries(Object.entries(api).map(([k, fn]) => [k, async (...a) => { await ensureSchema(db); return fn(...a); }]));
}

/** In-memory store with the same rules, for tests. */
export function memoryStore() {
  const claims = new Map(), added = [];
  const byWallet = (w) => [...claims.entries()].find(([, c]) => c.wallet === w);
  const insert = (c) => {
    if (claims.has(c.cityId) || byWallet(c.wallet)) throw new Error("UNIQUE constraint failed");
    claims.set(c.cityId, c);
  };
  return {
    async claimByWallet(w) { const e = byWallet(w); return e ? { city_id: e[0], city_name: e[1].cityName, country: e[1].country, claimed_at: e[1].at } : null; },
    async claimByCity(id) { const c = claims.get(id); return c ? { wallet: c.wallet, claimed_at: c.at } : null; },
    async addedCity(id) { return added.find((c) => c.id === Number(id)) || null; },
    async addedByName(country, norm) { return added.filter((c) => c.country === country && c.norm === norm); },
    async insertClaim(c) { insert(c); },
    async insertAddedCityAndClaim({ name, norm, country, lat, lon, wallet, at }) {
      const id = added.length + 1, cityId = "c" + id;
      insert({ cityId, wallet, cityName: name, country, at });
      added.push({ id, name, norm, country, lat, lon });
      return cityId;
    },
    async listAll() {
      return {
        claims: [...claims.entries()].map(([id, c]) => ({ city_id: id, wallet: c.wallet, city_name: c.cityName, country: c.country, claimed_at: c.at })),
        added: added.map(({ id, name, country, lat, lon }) => ({ id: "c" + id, name, country, lat, lon })),
      };
    },
  };
}
