const params = new URLSearchParams(location.search);
const urlToken = params.get("t");
if (urlToken) { localStorage.setItem("auth_token_reviewer", urlToken); history.replaceState({}, "", location.pathname); }
const TOKEN = localStorage.getItem("auth_token_reviewer");

const $ = (id) => document.getElementById(id);
const fmtDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};
const fmtTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
};
const toast = (msg) => {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2400);
};
const r1 = (n) => (n == null ? "—" : Math.round(n * 10) / 10);
const slotLabel = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", bedtime: "Bedtime", weight: "Weight" };

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Auth": TOKEN || "", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.headers.get("content-type")?.includes("application/json")) return res.json();
  return res;
};

let state = { days: 7, summary: null, scale: [], vapidPublic: null, user: null };

async function init() {
  if (!TOKEN) { $("auth-gate").classList.remove("hidden"); return; }
  try {
    const boot = await api("/api/bootstrap");
    if (!boot.user || boot.user.role !== "reviewer") {
      $("auth-gate").classList.remove("hidden");
      $("auth-gate").querySelector("p").textContent = "This link isn't for the reviewer view.";
      return;
    }
    state.user = boot.user;
    state.vapidPublic = boot.vapidPublic;
    $("header").classList.remove("hidden");
    $("tabs").classList.remove("hidden");
    $("main").classList.remove("hidden");
    $("hello").textContent = `Signed in as ${boot.user.name}.`;
    await registerSW();
    await loadAll();
  } catch (e) {
    $("auth-gate").classList.remove("hidden");
    $("auth-gate").querySelector("p").textContent = "Couldn't sign in. Use the reviewer link.";
  }
}

async function loadAll() {
  await loadSummary();
  await loadScale();
  updatePushStatus();
}

async function loadSummary() {
  const data = await api(`/api/reviewer/summary?days=${state.days}`);
  state.summary = data;
  if (data.patient) $("patient-name").textContent = `Patient: ${data.patient.name}`;
  renderStats(); renderFlags(); renderMissed(); renderReadingsTable();
}

function renderStats() {
  $("stats-label").textContent = `Summary · ${state.days} days`;
  const s = state.summary.stats;
  $("stats").innerHTML = `
    <div><div class="stat-label">Avg blood sugar</div><div class="stat-value">${r1(s.avgGlucose)} <span class="stat-unit">mg/dL</span></div></div>
    <div><div class="stat-label">Avg weight</div><div class="stat-value">${r1(s.avgWeight)} <span class="stat-unit">lb</span></div></div>
    <div><div class="stat-label">Total insulin</div><div class="stat-value">${r1(s.totalInsulin)} <span class="stat-unit">units</span></div></div>
    <div><div class="stat-label">Deviations / Missed</div><div class="stat-value" style="color:${s.deviations || s.missed ? "var(--red)" : "var(--ink)"}">${s.deviations} / ${s.missed}</div></div>
  `;
}

function renderFlags() {
  const card = $("flags-card");
  const flags = state.summary.flags || [];
  if (!flags.length) {
    card.querySelector("#flags").innerHTML = `<div class="hint">No deviations in this period.</div>`;
    return;
  }
  $("flags").innerHTML = `
    <table class="table">
      <thead><tr><th>Date</th><th>Slot</th><th class="num">Glucose</th><th class="num">Took</th><th class="num">Scale</th></tr></thead>
      <tbody>${flags.map((f) => `
        <tr class="flag-row">
          <td>${fmtDate(f.date)}</td>
          <td>${slotLabel[f.slot]} <span class="flag-pill">DEV</span></td>
          <td class="num">${f.glucose}</td>
          <td class="num"><b>${f.insulin_units ?? "—"}</b>u</td>
          <td class="num">${f.scale_expected ?? "—"}u</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function renderMissed() {
  const missed = state.summary.missed || [];
  if (!missed.length) {
    $("missed").innerHTML = `<div class="hint">No missed check-ins.</div>`;
    return;
  }
  $("missed").innerHTML = `
    <table class="table">
      <thead><tr><th>Date</th><th>Slot</th></tr></thead>
      <tbody>${missed.map((m) => `
        <tr><td>${fmtDate(m.date)}</td><td>${slotLabel[m.slot] || m.slot} <span class="flag-pill miss-pill">MISSED</span></td></tr>
      `).join("")}</tbody>
    </table>`;
}

function renderReadingsTable() {
  const readings = state.summary.readings || [];
  const weightsByDate = Object.fromEntries((state.summary.weights || []).map((w) => [w.date, w.weight_lb]));
  const seen = new Set();
  $("readings-table").innerHTML = `
    <thead><tr>
      <th>Date</th><th>Time</th><th>Slot</th>
      <th class="num">Glucose</th><th class="num">Insulin</th><th class="num">Scale</th>
      <th>Food</th><th class="num">Weight</th>
    </tr></thead>
    <tbody>${readings.map((r) => {
      const wt = !seen.has(r.date) && weightsByDate[r.date] != null ? weightsByDate[r.date] : "";
      seen.add(r.date);
      return `<tr class="${r.scale_flag ? "flag-row" : ""}">
        <td>${fmtDate(r.date)}</td>
        <td>${fmtTime(r.time)}</td>
        <td>${slotLabel[r.slot]}${r.scale_flag ? ' <span class="flag-pill">DEV</span>' : ""}</td>
        <td class="num">${r.glucose}</td>
        <td class="num">${r.insulin_units ?? "—"}</td>
        <td class="num">${r.scale_expected ?? "—"}</td>
        <td>${escape(r.food || "")}</td>
        <td class="num">${wt}</td>
      </tr>`;
    }).join("")}</tbody>`;
}
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

async function loadScale() {
  state.scale = await api("/api/reviewer/scale");
  renderScale();
}

function renderScale() {
  const c = $("scale-rows");
  c.innerHTML = state.scale.map((r, i) => `
    <div class="row" style="align-items:center; margin-bottom:10px; flex-wrap:wrap">
      <span style="color:var(--sub); font-weight:700">If</span>
      <input type="number" inputmode="numeric" value="${r.from_glucose}" data-i="${i}" data-k="from"  style="width:96px" />
      <span style="color:var(--sub)">–</span>
      <input type="number" inputmode="numeric" value="${r.to_glucose}"   data-i="${i}" data-k="to"    style="width:96px" />
      <span style="color:var(--sub); font-weight:700">→</span>
      <input type="number" inputmode="decimal" step="0.5" value="${r.units}" data-i="${i}" data-k="units" style="width:96px" />
      <span style="color:var(--sub)">u</span>
      <button class="link-btn" style="color:var(--red); margin-left:auto" data-del="${i}">Remove</button>
    </div>
  `).join("");
  c.querySelectorAll("input").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const i = +e.target.dataset.i; const k = e.target.dataset.k;
      state.scale[i][k === "from" ? "from_glucose" : k === "to" ? "to_glucose" : "units"] = e.target.value;
    });
  });
  c.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = () => { state.scale.splice(+b.dataset.del, 1); renderScale(); };
  });
}

$("add-scale-row").onclick = () => {
  state.scale.push({ from_glucose: "", to_glucose: "", units: "" });
  renderScale();
};
$("save-scale").onclick = async () => {
  const rows = state.scale
    .filter((r) => r.from_glucose !== "" && r.to_glucose !== "" && r.units !== "")
    .map((r) => ({ from: Number(r.from_glucose), to: Number(r.to_glucose), units: Number(r.units) }));
  await api("/api/reviewer/scale", { method: "POST", body: JSON.stringify({ rows }) });
  toast("Sliding scale saved");
  loadScale();
};

// tabs
document.querySelectorAll(".tab").forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    ["overview", "readings", "scale"].forEach((k) => $(`tab-${k}`).classList.toggle("hidden", k !== t.dataset.tab));
  };
});

// range chips
document.querySelectorAll(".chip[data-days]").forEach((c) => {
  c.onclick = () => {
    document.querySelectorAll(".chip[data-days]").forEach((x) => x.classList.toggle("active", x === c));
    state.days = Number(c.dataset.days);
    loadSummary();
  };
});

// export
$("export-btn").onclick = () => {
  const url = `/api/reviewer/export.csv?days=${state.days}&t=${encodeURIComponent(TOKEN)}`;
  window.location.href = url;
};

// push (reviewer)
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("/sw.js"); } catch (e) {}
}
function urlBase64ToUint8Array(s) {
  const padding = "=".repeat((4 - (s.length % 4)) % 4);
  const b = (s + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b); const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
async function updatePushStatus() {
  const btn = $("push-btn");
  if (!("Notification" in window) || !("PushManager" in window) || !state.vapidPublic) {
    btn.classList.add("hidden"); return;
  }
  if (Notification.permission === "granted") {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) { btn.textContent = "Notifications on · send test"; btn.onclick = async () => { await api("/api/push/test", { method: "POST" }); toast("Test sent"); }; return; }
  }
  btn.textContent = "Turn on reviewer notifications";
  btn.onclick = async () => {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return toast("Declined");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(state.vapidPublic) });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({
      endpoint: sub.endpoint,
      keys: {
        p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
        auth:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth"))))  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
      }
    }) });
    toast("Notifications on");
    updatePushStatus();
  };
}

init();
