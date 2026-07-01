import webpush from "web-push";
import { db } from "./db.js";

const PUB = process.env.VAPID_PUBLIC;
const PRV = process.env.VAPID_PRIVATE;
const SUB = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

if (!PUB || !PRV) {
  console.warn("[push] VAPID keys not set — push disabled. Run scripts/generate-keys.js");
} else {
  webpush.setVapidDetails(SUB, PUB, PRV);
}

export const VAPID_PUBLIC = PUB;

export const pushToUser = async (userId, payload) => {
  if (!PUB || !PRV) return { sent: 0, failed: 0 };
  const subs = db.prepare("SELECT * FROM push_subs WHERE user_id = ?").all(userId);
  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload)
      );
      sent++;
    } catch (e) {
      failed++;
      // 404/410 = subscription gone, clean it up
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.prepare("DELETE FROM push_subs WHERE id = ?").run(s.id);
      } else {
        console.error("[push] failed:", e.statusCode, e.body);
      }
    }
  }
  return { sent, failed };
};
