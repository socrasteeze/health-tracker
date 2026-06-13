// ---------- token + auth ----------
const params = new URLSearchParams(location.search);
const urlToken = params.get("t");
if (urlToken) {
  localStorage.setItem("auth_token", urlToken);
  history.replaceState({}, "", location.pathname);
}
const TOKEN = localStorage.getItem("auth_token");

// ---------- utilities ----------
const $ = (id) => document.getElementById(id);
const fmtDateLong = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
};
const fmtTime = (t) => {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
};
const ptToday = () => {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
};
const ptNow = () => {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", hour12: false });
  return fmt.format(new Date());
};
const ptHour = () => Number(ptNow().split(":")[0]);
const toast = (msg) => {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2400);
};

const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Auth": TOKEN || "", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status}: ${t}`);
  }
  return res.json();
};

const RANGE_LO = 70, RANGE_HI = 180;
const rangeOf = (g) => (g < RANGE_LO ? "low" : g > RANGE_HI ? "high" : "ok");
const rangeColor = { low: "var(--red)", high: "var(--amber)", ok: "var(--green)" };
const rangeLabel = { low: "Low", high: "High", ok: "In range" };
const slotLabel = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", bedtime: "Bedtime" };

// ---------- init ----------
let state = { weight: null, readings: [], user: null };

async function init() {
  if (!TOKEN) { $("auth-gate").classList.remove("hidden"); return; }
  try {
    const boot = await api("/api/bootstrap");
    if (!boot.user || boot.user.role !== "patient") {
      $("auth-gate").classList.remove("hidden");
      $("auth-gate").querySelector("p").textContent = "This link isn't for the patient view. Check with your reviewer.";
      return;
    }
    state.user = boot.user;
    state.vapidPublic = boot.vapidPublic;
    $("header").classList.remove("hidden");
    $("main").classList.remove("hidden");
    $("today-date").textContent = fmtDateLong(ptToday());
    $("hello").textContent = `Hi ${boot.user.name}.`;
    await refresh();
    await registerSW();
    updatePushStatus();
    // honor prompt deep-link from notification: ?slot=breakfast
    const slotParam = params.get("slot");
    if (slotParam && slotParam !== "weight") openReading(null, slotParam);
    else if (slotParam === "weight") openWeight();
  } catch (e) {
    $("auth-gate").classList.remove("hidden");
    $("auth-gate").querySelector("p").textContent = "Couldn't sign in. Use the link your reviewer sent you.";
  }
}

async function refresh() {
  const data = await api(`/api/today?date=${ptToday()}`);
  state.weight = data.weight;
  state.readings = data.readings;
  renderWeight();
  renderReadings();
}

function renderWeight() {
  const el = $("weight-view");
  if (state.weight == null) {
    el.innerHTML = `
      <div class="weight-empty">Not logged yet today.</div>
      <button class="link-btn" id="log-weight" style="margin-top:8px">Log today's weight</button>`;
  } else {
    el.innerHTML = `
      <div class="weight-view">
        <span class="weight-num">${state.weight}</span><span class="weight-unit">lb</span>
        <button class="link-btn" id="log-weight" style="margin-left:auto">Change</button>
      </div>`;
  }
  $("log-weight").onclick = openWeight;
}

function renderReadings() {
  const list = $("readings-list");
  if (!state.readings.length) {
    list.innerHTML = `<div class="empty-state">No readings yet today.<br>Tap the button above after you check your blood sugar.</div>`;
    return;
  }
  list.innerHTML = state.readings.map((r) => {
    const rng = rangeOf(r.glucose);
    const showFood = r.slot !== "bedtime";
    return `
      <div class="reading">
        <div class="reading-head">
          <span class="reading-slot">${slotLabel[r.slot] || r.slot}</span>
          <span class="reading-time">${fmtTime(r.time)}</span>
          <span class="reading-range" style="color:${rangeColor[rng]}">
            <span class="dot" style="background:${rangeColor[rng]}"></span>${rangeLabel[rng]}
          </span>
        </div>
        <div class="reading-body">
          <span class="reading-glucose">${r.glucose}</span>
          <span class="reading-glucose-unit">mg/dL</span>
          ${r.insulin_units != null ? `<span class="reading-insulin">${r.insulin_units}u insulin</span>` : ""}
        </div>
        ${showFood && r.food ? `<div class="reading-food">${escape(r.food)}</div>` : ""}
      </div>`;
  }).join("");
}
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// ---------- weight modal ----------
function openWeight() {
  $("weight-input").value = state.weight ?? "";
  $("weight-modal").classList.remove("hidden");
  setTimeout(() => $("weight-input").focus(), 50);
}
$("weight-save").onclick = async () => {
  const v = parseFloat($("weight-input").value);
  if (!v || v <= 0) { toast("Enter a number first"); return; }
  await api("/api/weight", { method: "POST", body: JSON.stringify({ date: ptToday(), weight_lb: v }) });
  $("weight-modal").classList.add("hidden");
  toast("Weight saved");
  refresh();
};

// ---------- reading modal ----------
$("add-reading").onclick = () => openReading();

function defaultSlot() {
  const h = ptHour();
  if (h < 10) return "breakfast";
  if (h < 14) return "lunch";
  if (h < 19) return "dinner";
  return "bedtime";
}

function openReading(_id, preset) {
  const slot = preset || defaultSlot();
  setSlot(slot);
  $("reading-date").value = ptToday();
  $("reading-time").value = ptNow();
  $("reading-glucose").value = "";
  $("reading-insulin").value = "";
  $("reading-food").value = "";
  $("reading-error").classList.add("hidden");
  $("reading-modal").classList.remove("hidden");
  setTimeout(() => $("reading-glucose").focus(), 50);
}

function setSlot(slot) {
  document.querySelectorAll("#slot-chips .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.slot === slot);
  });
  const isBed = slot === "bedtime";
  $("insulin-field").classList.toggle("hidden", isBed);
  $("food-field").classList.toggle("hidden", isBed);
  $("reading-title").textContent = isBed ? "Bedtime check" : "New reading";
}
document.querySelectorAll("#slot-chips .chip").forEach((c) => {
  c.onclick = () => setSlot(c.dataset.slot);
});

$("reading-save").onclick = async () => {
  const slot = document.querySelector("#slot-chips .chip.active")?.dataset.slot;
  const glucose = parseInt($("reading-glucose").value, 10);
  if (!slot) return showErr("Pick a meal");
  if (!glucose || glucose <= 0) return showErr("Enter your blood sugar number first");
  const body = {
    date: $("reading-date").value, slot,
    time: $("reading-time").value, glucose,
    insulin_units: slot === "bedtime" ? null : ($("reading-insulin").value || null),
    food: slot === "bedtime" ? null : $("reading-food").value.trim(),
  };
  await api("/api/reading", { method: "POST", body: JSON.stringify(body) });
  $("reading-modal").classList.add("hidden");
  toast("Reading saved");
  refresh();
};
function showErr(msg) { const e = $("reading-error"); e.textContent = msg; e.classList.remove("hidden"); }

// ---------- modal close ----------
document.addEventListener("click", (e) => {
  if (e.target.matches("[data-close]")) {
    if (e.target.closest("[data-stop]") && !e.target.matches(".x")) return;
    e.target.closest(".modal")?.classList.add("hidden");
  }
});
document.querySelectorAll("[data-stop]").forEach((el) => el.addEventListener("click", (e) => e.stopPropagation()));

// ---------- push ----------
async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { await navigator.serviceWorker.register("/sw.js"); } catch (e) { console.warn("SW registration failed:", e); }
}

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function updatePushStatus() {
  const status = $("push-status");
  const btn = $("enable-push");
  if (!("Notification" in window) || !("PushManager" in window)) {
    btn.classList.add("hidden");
    status.textContent = "This device doesn't support reminders. Bookmark this page and check in at meal times.";
    return;
  }
  if (!state.vapidPublic) {
    btn.classList.add("hidden");
    status.textContent = "Reminders aren't set up on the server yet.";
    return;
  }
  if (Notification.permission === "granted") {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      btn.textContent = "Send test notification";
      btn.onclick = async () => { await api("/api/push/test", { method: "POST" }); toast("Test sent"); };
      status.textContent = "Reminders are on. You'll get a tap at 7am, 8am, 12pm, 6pm, and 8pm.";
      return;
    }
  }
  btn.classList.remove("hidden");
  btn.textContent = "Turn on notifications";
  btn.onclick = subscribePush;
  status.textContent = "Tap the button above to get a tap at meal times.";
}

async function subscribePush() {
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { toast("Notifications declined"); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.vapidPublic),
    });
    await api("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({
        endpoint: sub.endpoint,
        keys: {
          p256dh: btoa(String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
          auth:   btoa(String.fromCharCode(...new Uint8Array(sub.getKey("auth"))))  .replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,""),
        },
      }),
    });
    toast("Notifications on");
    updatePushStatus();
  } catch (e) {
    console.error(e);
    toast("Couldn't enable notifications");
  }
}

init();
