import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { db, getUserByToken, getPatient, getReviewers, expectedInsulin } from "./db.js";
import { VAPID_PUBLIC, pushToUser } from "./push.js";
import { startScheduler, _internals } from "./scheduler.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(express.static(PUBLIC_DIR));

// --- auth middleware ---
const auth = (allowedRoles) => (req, res, next) => {
  const token = req.headers["x-auth"] || req.query.t;
  if (!token) return res.status(401).json({ error: "missing token" });
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: "invalid token" });
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return res.status(403).json({ error: "forbidden" });
  }
  req.user = user;
  next();
};

// --- public bootstrap ---
app.get("/api/bootstrap", (req, res) => {
  const token = req.headers["x-auth"] || req.query.t;
  const user = token ? getUserByToken(token) : null;
  res.json({
    vapidPublic: VAPID_PUBLIC || null,
    user: user ? { id: user.id, role: user.role, name: user.name } : null,
  });
});

// --- patient endpoints ---
app.post("/api/weight", auth(["patient"]), (req, res) => {
  const { date, weight_lb } = req.body;
  if (!date || !weight_lb) return res.status(400).json({ error: "date and weight_lb required" });
  db.prepare(
    "INSERT INTO weights(user_id,date,weight_lb) VALUES(?,?,?) " +
    "ON CONFLICT(user_id,date) DO UPDATE SET weight_lb = excluded.weight_lb, logged_at = datetime('now')"
  ).run(req.user.id, date, Number(weight_lb));
  res.json({ ok: true });
});

app.post("/api/reading", auth(["patient"]), (req, res) => {
  const { date, slot, time, glucose, insulin_units, food } = req.body;
  if (!date || !slot || !time || glucose == null) {
    return res.status(400).json({ error: "date, slot, time, glucose required" });
  }
  if (!["breakfast", "lunch", "dinner", "bedtime"].includes(slot)) {
    return res.status(400).json({ error: "invalid slot" });
  }

  const g = Number(glucose);
  const isBedtime = slot === "bedtime";
  // Invariant #4: bedtime carries glucose only — no insulin, food, or sliding-scale.
  const ins = isBedtime || insulin_units === "" || insulin_units == null ? null : Number(insulin_units);
  const foodVal = isBedtime ? null : (food || null);
  const expected = isBedtime ? null : expectedInsulin(req.user.id, g);
  // flag if expected exists and patient deviated (any non-zero diff, rounded to 0.5)
  const flag = expected != null && ins != null && Math.abs(ins - expected) >= 0.5 ? 1 : 0;

  const info = db.prepare(
    "INSERT INTO readings(user_id,date,slot,time,glucose,insulin_units,food,scale_expected,scale_flag) " +
    "VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(req.user.id, date, slot, time, g, ins, foodVal, expected, flag);

  // clear any prior missed marker for this slot today
  db.prepare("DELETE FROM missed WHERE user_id = ? AND date = ? AND slot = ?")
    .run(req.user.id, date, slot);

  // if flagged, push to reviewers immediately
  if (flag) {
    const reviewers = getReviewers();
    const body = `${req.user.name}: ${slot} ${g} mg/dL — took ${ins}u (scale: ${expected}u).`;
    for (const r of reviewers) {
      pushToUser(r.id, {
        title: "Insulin deviation",
        body,
        tag: `flag-${info.lastInsertRowid}`,
        url: "/reviewer.html",
      }).catch(() => {});
    }
  }
  res.json({ ok: true, id: info.lastInsertRowid, flagged: !!flag });
});

app.get("/api/today", auth(["patient", "reviewer"]), (req, res) => {
  const date = req.query.date || _internals.todayPT();
  const patient = req.user.role === "patient" ? req.user : getPatient();
  if (!patient) return res.json({ date, weight: null, readings: [] });

  const weight = db.prepare("SELECT weight_lb FROM weights WHERE user_id = ? AND date = ?").get(patient.id, date);
  const readings = db.prepare(
    "SELECT id,slot,time,glucose,insulin_units,food,scale_expected,scale_flag FROM readings WHERE user_id = ? AND date = ? ORDER BY time"
  ).all(patient.id, date);
  res.json({ date, weight: weight?.weight_lb ?? null, readings });
});

// --- push subscription ---
app.post("/api/push/subscribe", auth(["patient", "reviewer"]), (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: "bad sub" });
  db.prepare(
    "INSERT INTO push_subs(user_id,endpoint,p256dh,auth) VALUES(?,?,?,?) " +
    "ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth"
  ).run(req.user.id, endpoint, keys.p256dh, keys.auth);
  res.json({ ok: true });
});

app.post("/api/push/test", auth(["patient", "reviewer"]), async (req, res) => {
  const r = await pushToUser(req.user.id, {
    title: "Test notification",
    body: "Push is wired up. You're good.",
    tag: "test",
    url: "/",
  });
  res.json(r);
});

// --- reviewer endpoints ---
app.get("/api/reviewer/summary", auth(["reviewer"]), (req, res) => {
  const patient = getPatient();
  if (!patient) return res.json({ patient: null });
  const days = Number(req.query.days) || 7;
  const cutoff = _internals.dateMinus(_internals.todayPT(), days - 1);

  const readings = db.prepare(
    "SELECT date,slot,time,glucose,insulin_units,food,scale_expected,scale_flag FROM readings " +
    "WHERE user_id = ? AND date >= ? ORDER BY date DESC, time DESC"
  ).all(patient.id, cutoff);
  const weights = db.prepare(
    "SELECT date,weight_lb FROM weights WHERE user_id = ? AND date >= ? ORDER BY date DESC"
  ).all(patient.id, cutoff);
  const missed = db.prepare(
    "SELECT date,slot,created_at FROM missed WHERE user_id = ? AND date >= ? ORDER BY date DESC, slot"
  ).all(patient.id, cutoff);
  const flags = readings.filter((r) => r.scale_flag);

  const glucoseVals = readings.map((r) => r.glucose);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const stats = {
    avgGlucose: avg(glucoseVals),
    avgWeight: avg(weights.map((w) => w.weight_lb)),
    totalInsulin: readings.reduce((s, r) => s + (r.insulin_units || 0), 0),
    deviations: flags.length,
    missed: missed.length,
    readingCount: readings.length,
  };

  res.json({
    patient: { id: patient.id, name: patient.name },
    days, stats, readings, weights, missed, flags,
  });
});

app.get("/api/reviewer/export.csv", auth(["reviewer"]), (req, res) => {
  const patient = getPatient();
  if (!patient) return res.status(404).send("no patient");
  const days = Number(req.query.days) || 30;
  const cutoff = _internals.dateMinus(_internals.todayPT(), days - 1);

  const readings = db.prepare(
    "SELECT date,slot,time,glucose,insulin_units,food,scale_expected,scale_flag FROM readings " +
    "WHERE user_id = ? AND date >= ? ORDER BY date, time"
  ).all(patient.id, cutoff);
  const weights = Object.fromEntries(
    db.prepare("SELECT date,weight_lb FROM weights WHERE user_id = ? AND date >= ?")
      .all(patient.id, cutoff).map((w) => [w.date, w.weight_lb])
  );

  const rows = [["Date", "Slot", "Time", "Glucose (mg/dL)", "Insulin (u)", "Scale expected (u)", "Flagged", "Food", "Weight (lb)"]];
  const seen = new Set();
  for (const r of readings) {
    const wt = !seen.has(r.date) && weights[r.date] != null ? weights[r.date] : "";
    seen.add(r.date);
    rows.push([r.date, r.slot, r.time, r.glucose, r.insulin_units ?? "", r.scale_expected ?? "",
               r.scale_flag ? "YES" : "", (r.food || "").replace(/"/g, "'"), wt]);
  }
  // Neutralize spreadsheet formula injection: a cell beginning with = + - @
  // is prefixed with ' so Excel/Sheets treats it as text, not a formula.
  const csvCell = (c) => {
    let s = String(c);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="health-log-${cutoff}.csv"`);
  res.send(csv);
});

app.get("/api/reviewer/scale", auth(["reviewer"]), (req, res) => {
  const patient = getPatient();
  if (!patient) return res.json([]);
  const rows = db.prepare(
    "SELECT id,from_glucose,to_glucose,units FROM scale WHERE user_id = ? ORDER BY from_glucose"
  ).all(patient.id);
  res.json(rows);
});

app.post("/api/reviewer/scale", auth(["reviewer"]), (req, res) => {
  const patient = getPatient();
  if (!patient) return res.status(404).json({ error: "no patient" });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM scale WHERE user_id = ?").run(patient.id);
    const ins = db.prepare("INSERT INTO scale(user_id,from_glucose,to_glucose,units) VALUES(?,?,?,?)");
    for (const r of rows) {
      if (r.from != null && r.to != null && r.units != null) {
        ins.run(patient.id, Number(r.from), Number(r.to), Number(r.units));
      }
    }
  });
  tx();
  res.json({ ok: true });
});

// --- debug ---
app.get("/api/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT}`);
  startScheduler();
});
