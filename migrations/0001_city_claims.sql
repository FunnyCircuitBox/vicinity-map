-- City claims. Run once in Cloudflare → D1 → vicinity-claims → Console.
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
