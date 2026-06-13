import cron from "node-cron";
import { db, getPatient, getReviewers } from "./db.js";
import { pushToUser } from "./push.js";

const TZ = "America/Los_Angeles";

const todayPT = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date()); // YYYY-MM-DD
};

const SLOTS = {
  weight:    { hour: 7,  min: 0,  title: "Morning weigh-in", body: "Tap to log today's weight." },
  breakfast: { hour: 8,  min: 0,  title: "Breakfast check", body: "Log your blood sugar, insulin, and what you're eating." },
  lunch:     { hour: 12, min: 0,  title: "Lunch check",     body: "Log your blood sugar, insulin, and what you're eating." },
  dinner:    { hour: 18, min: 0,  title: "Dinner check",    body: "Log your blood sugar, insulin, and what you're eating." },
  bedtime:   { hour: 20, min: 0,  title: "Bedtime check",   body: "Log your blood sugar before nighttime insulin." },
};

const wasLogged = (userId, date, slot) => {
  if (slot === "weight") {
    return !!db.prepare("SELECT 1 FROM weights WHERE user_id = ? AND date = ?").get(userId, date);
  }
  return !!db.prepare("SELECT 1 FROM readings WHERE user_id = ? AND date = ? AND slot = ?").get(userId, date, slot);
};

const recordPrompt = (userId, date, slot) => {
  db.prepare("INSERT OR IGNORE INTO prompt_log(user_id,date,slot) VALUES(?,?,?)").run(userId, date, slot);
};

const sendPrompt = async (slot, isReminder = false) => {
  const patient = getPatient();
  if (!patient) return;
  const date = todayPT();
  const def = SLOTS[slot];
  if (!def) return;

  if (!isReminder) recordPrompt(patient.id, date, slot);
  if (wasLogged(patient.id, date, slot)) return;

  await pushToUser(patient.id, {
    title: isReminder ? `Reminder: ${def.title}` : def.title,
    body: def.body,
    tag: `prompt-${slot}-${date}`,
    url: "/",
    slot,
  });
  console.log(`[scheduler] ${isReminder ? "REMINDER" : "PROMPT"} ${slot} → patient ${patient.id}`);
};

const checkMissed = async (slot) => {
  const patient = getPatient();
  if (!patient) return;
  const date = todayPT();

  if (wasLogged(patient.id, date, slot)) return;

  const existing = db.prepare(
    "SELECT * FROM missed WHERE user_id = ? AND date = ? AND slot = ?"
  ).get(patient.id, date, slot);
  if (existing && existing.notified_reviewer) return;

  db.prepare(
    "INSERT INTO missed(user_id,date,slot,notified_reviewer) VALUES(?,?,?,1) " +
    "ON CONFLICT(user_id,date,slot) DO UPDATE SET notified_reviewer = 1"
  ).run(patient.id, date, slot);

  const reviewers = getReviewers();
  const body = `${patient.name} hasn't logged ${slot} (${date}). T+60 min.`;
  for (const r of reviewers) {
    await pushToUser(r.id, {
      title: "Missed check-in",
      body,
      tag: `missed-${slot}-${date}`,
      url: "/reviewer.html",
    });
  }
  console.log(`[scheduler] MISSED ${slot} → ${reviewers.length} reviewer(s) alerted`);
};

const minutes = (h, m, addMin) => {
  const total = h * 60 + m + addMin;
  return { hour: Math.floor(total / 60) % 24, min: total % 60 };
};

export const startScheduler = () => {
  for (const [slot, def] of Object.entries(SLOTS)) {
    const t0 = def;
    const t1 = minutes(def.hour, def.min, 30);
    const t2 = minutes(def.hour, def.min, 60);

    cron.schedule(`${t0.min} ${t0.hour} * * *`, () => sendPrompt(slot, false), { timezone: TZ });
    cron.schedule(`${t1.min} ${t1.hour} * * *`, () => sendPrompt(slot, true),  { timezone: TZ });
    cron.schedule(`${t2.min} ${t2.hour} * * *`, () => checkMissed(slot),       { timezone: TZ });
  }
  console.log(`[scheduler] armed · TZ=${TZ} · slots=${Object.keys(SLOTS).join(",")}`);
};

// for manual triggers (debug / health endpoint)
export const _internals = { sendPrompt, checkMissed, todayPT, SLOTS };
