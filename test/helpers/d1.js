// A tiny stand-in for Cloudflare D1 on top of Node's built-in SQLite, so tests run the real SQL.
import { DatabaseSync } from "node:sqlite";

const val = (v) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
const returnsRows = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);

export function d1() {
  const db = new DatabaseSync(":memory:");
  const statement = (sql, params = []) => ({
    sql, params,
    bind: (...p) => statement(sql, p.map(val)),
    async first(col) {
      const row = db.prepare(sql).get(...params);
      if (!row) return null;
      const plain = { ...row };
      return col ? plain[col] : plain;
    },
    async all() { return { results: db.prepare(sql).all(...params).map((r) => ({ ...r })), success: true, meta: {} }; },
    async run() {
      const r = db.prepare(sql).run(...params);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      db.exec("BEGIN");
      try {
        const out = [];
        for (const s of list) out.push(returnsRows(s.sql) ? await s.all() : await s.run());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    _raw: db,
  };
}
