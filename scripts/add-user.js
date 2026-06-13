// Usage:
//   node scripts/add-user.js patient   "First Last" "email@example.com"
//   node scripts/add-user.js reviewer  "First Last" "email@example.com"
//   node scripts/add-user.js list
//   node scripts/add-user.js delete    <id>
import { db, newToken } from "../server/db.js";

const cmd = process.argv[2];
const BASE = process.env.PUBLIC_URL || "https://health.yourdomain.com";

if (cmd === "list") {
  const rows = db.prepare("SELECT id,role,name,email,token,created_at FROM users").all();
  for (const r of rows) {
    const path = r.role === "patient" ? "/" : "/reviewer.html";
    console.log(`${r.id}  ${r.role.padEnd(8)}  ${r.name.padEnd(24)}  ${r.email || ""}`);
    console.log(`         link: ${BASE}${path}?t=${r.token}\n`);
  }
} else if (cmd === "delete") {
  const id = Number(process.argv[3]);
  const info = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  console.log(`deleted ${info.changes} user(s)`);
} else if (cmd === "patient" || cmd === "reviewer") {
  const name = process.argv[3];
  const email = process.argv[4] || null;
  if (!name) { console.error("name required"); process.exit(1); }
  if (cmd === "patient") {
    const existing = db.prepare("SELECT id FROM users WHERE role = 'patient'").get();
    if (existing) { console.error("a patient already exists. delete it first (only one supported)."); process.exit(1); }
  }
  const token = newToken();
  const info = db.prepare("INSERT INTO users(role,name,email,token) VALUES(?,?,?,?)").run(cmd, name, email, token);
  const path = cmd === "patient" ? "/" : "/reviewer.html";
  console.log(`\nCreated ${cmd} #${info.lastInsertRowid}: ${name}`);
  console.log(`\nSEND THEM THIS LINK (single-use bookmark):`);
  console.log(`  ${BASE}${path}?t=${token}\n`);
} else {
  console.log(`usage:
  node scripts/add-user.js patient   "Name" [email]
  node scripts/add-user.js reviewer  "Name" [email]
  node scripts/add-user.js list
  node scripts/add-user.js delete <id>`);
}
