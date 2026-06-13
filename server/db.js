import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.DB_PATH || "/data/health.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK(role IN ('patient','reviewer')),
    name TEXT NOT NULL,
    email TEXT,
    token TEXT NOT NULL UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS weights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    weight_lb REAL NOT NULL,
    logged_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    slot TEXT NOT NULL CHECK(slot IN ('breakfast','lunch','dinner','bedtime')),
    time TEXT NOT NULL,
    glucose INTEGER NOT NULL,
    insulin_units REAL,
    food TEXT,
    scale_expected REAL,
    scale_flag INTEGER DEFAULT 0,
    logged_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_readings_user_date ON readings(user_id, date);

  CREATE TABLE IF NOT EXISTS scale (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_glucose INTEGER NOT NULL,
    to_glucose INTEGER NOT NULL,
    units REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS missed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    notified_reviewer INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date, slot)
  );

  CREATE TABLE IF NOT EXISTS push_subs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompt_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    sent_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, date, slot)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// helpers
export const newToken = () => randomBytes(24).toString("base64url");
export const getUserByToken = (token) =>
  db.prepare("SELECT * FROM users WHERE token = ?").get(token);
export const getPatient = () =>
  db.prepare("SELECT * FROM users WHERE role = 'patient' LIMIT 1").get();
export const getReviewers = () =>
  db.prepare("SELECT * FROM users WHERE role = 'reviewer'").all();
export const getSetting = (k) => {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(k);
  return r ? r.value : null;
};
export const setSetting = (k, v) =>
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);

export const expectedInsulin = (userId, glucose) => {
  const row = db.prepare(
    "SELECT units FROM scale WHERE user_id = ? AND ? BETWEEN from_glucose AND to_glucose ORDER BY from_glucose LIMIT 1"
  ).get(userId, glucose);
  return row ? row.units : null;
};
