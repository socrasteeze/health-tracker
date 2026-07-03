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
const GLUCOSE_MIN = 20, GLUCOSE_MAX = 600;
const WEIGHT_MIN = 50, WEIGHT_MAX = 500;
const INSULIN_MAX = 30;

const rangeOf = (g) => (g < RANGE_LO ? "low" : g > RANGE_HI ? "high" : "ok");
const rangeColor = { low: "var(--red)", high: "var(--amber)", ok: "var(--green)" };
const rangeLabel = { low: "Low", high: "High", ok: "In range" };
const slotLabel = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner", bedtime: "Bedtime" };

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

// ---------- init ----------
let state = { weight: null, readings: [], user: null };
let wizard = { slot: null, glucose: null, insulin: null, food: "", steps: [], stepIdx: 0, glucoseConfirmed: false };

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
    const slotParam = params.get("slot");
    if (slotParam && slotParam !== "weight") openReading(null, slotParam, true);
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
    el.innerHTML = `<button class="big-btn quiet" id="log-weight">Log today's weight</button>`;
  } else {
    el.innerHTML = `
      <div class="weight-view">
        <span class="weight-num">${state.weight}</span><span class="weight-unit">lb</span>
        <button class="big-btn quiet weight-change" id="log-weight">Change</button>
      </div>`;
  }
  $("log-weight").onclick = openWeight;
}

function renderReadings() {
  const list = $("readings-list");
  if (!state.readings.length) {
    list.innerHTML = `<div class="empty-state">No readings yet today.<br>Tap <strong>Log blood sugar</strong> after each check.</div>`;
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

// ---------- weight modal ----------
function openWeight() {
  $("weight-input").value = state.weight ?? "";
  $("weight-error").classList.add("hidden");
  updateWeightPreview();
  $("weight-modal").classList.remove("hidden");
  setTimeout(() => $("weight-input").focus(), 50);
}

function updateWeightPreview() {
  const v = parseFloat($("weight-input").value);
  const box = $("weight-preview");
  if (!v || v <= 0) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  box.innerHTML = `<span class="preview-num">${v}</span> <span class="preview-unit">lb</span>`;
}

$("weight-input").addEventListener("input", updateWeightPreview);

$("weight-save").onclick = async () => {
  const v = parseFloat($("weight-input").value);
  const err = $("weight-error");
  if (!v || v <= 0) {
    err.textContent = "Enter your weight from the scale.";
    err.classList.remove("hidden");
    return;
  }
  if (v < WEIGHT_MIN || v > WEIGHT_MAX) {
    err.textContent = `Weight should be between ${WEIGHT_MIN} and ${WEIGHT_MAX} lb. Check the number.`;
    err.classList.remove("hidden");
    return;
  }
  err.classList.add("hidden");
  await api("/api/weight", { method: "POST", body: JSON.stringify({ date: ptToday(), weight_lb: v }) });
  $("weight-modal").classList.add("hidden");
  toast("Weight saved");
  refresh();
};

// ---------- reading wizard ----------
$("add-reading").onclick = () => openReading();

function defaultSlot() {
  const h = ptHour();
  if (h < 10) return "breakfast";
  if (h < 14) return "lunch";
  if (h < 19) return "dinner";
  return "bedtime";
}

function stepsForSlot(slot) {
  if (slot === "bedtime") return ["slot", "glucose", "confirm"];
  return ["slot", "glucose", "insulin", "food", "confirm"];
}

function openReading(_id, preset, skipSlot = false) {
  const slot = preset || defaultSlot();
  wizard = {
    slot,
    glucose: null,
    insulin: null,
    food: "",
    steps: stepsForSlot(slot),
    stepIdx: 0,
    glucoseConfirmed: false,
  };
  $("reading-date").value = ptToday();
  $("reading-time").value = ptNow();
  $("reading-glucose").value = "";
  $("reading-insulin-custom").value = "";
  $("reading-food").value = "";
  $("reading-error").classList.add("hidden");
  $("glucose-error").classList.add("hidden");
  $("glucose-warn").classList.add("hidden");
  $("insulin-custom-field").classList.add("hidden");
  clearInsulinSelection();
  setSlotChip(slot);
  renderWizardProgress();
  showWizardStep(skipSlot && preset ? 1 : 0);
  $("reading-modal").classList.remove("hidden");
}

function renderWizardProgress() {
  const bar = $("wizard-progress");
  bar.innerHTML = wizard.steps.map((_, i) =>
    `<span class="wizard-dot${i <= wizard.stepIdx ? " active" : ""}"></span>`
  ).join("");
  bar.classList.toggle("hidden", wizard.steps.length <= 2);
}

function setSlotChip(slot) {
  document.querySelectorAll("#slot-chips .chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.slot === slot);
  });
  const isBed = slot === "bedtime";
  $("reading-title").textContent = isBed ? "Bedtime check" : "Log reading";
}

document.querySelectorAll("#slot-chips .chip").forEach((c) => {
  c.onclick = () => {
    wizard.slot = c.dataset.slot;
    wizard.steps = stepsForSlot(wizard.slot);
    setSlotChip(wizard.slot);
    renderWizardProgress();
    advanceWizard();
  };
});

function showWizardStep(idx) {
  wizard.stepIdx = idx;
  const step = wizard.steps[idx];
  document.querySelectorAll(".wizard-step").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.step !== step);
  });
  renderWizardProgress();
  $("wizard-back").classList.toggle("hidden", idx === 0);

  if (step === "glucose") {
    setTimeout(() => $("reading-glucose").focus(), 50);
    updateGlucosePreview();
  }
  if (step === "confirm") renderConfirmSummary();
}

function advanceWizard() {
  if (wizard.stepIdx < wizard.steps.length - 1) showWizardStep(wizard.stepIdx + 1);
}

function retreatWizard() {
  if (wizard.stepIdx > 0) showWizardStep(wizard.stepIdx - 1);
}

$("wizard-back").onclick = retreatWizard;
$("reading-back").onclick = retreatWizard;

function parseGlucose() {
  const raw = $("reading-glucose").value.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return parseInt(raw, 10);
}

function updateGlucosePreview() {
  const g = parseGlucose();
  const box = $("glucose-preview");
  const warn = $("glucose-warn");
  if (g == null) { box.classList.add("hidden"); warn.classList.add("hidden"); return; }
  const rng = rangeOf(g);
  box.classList.remove("hidden");
  box.innerHTML = `
    <span class="preview-num" style="color:${rangeColor[rng]}">${g}</span>
    <span class="preview-unit">mg/dL</span>
    <span class="preview-tag" style="color:${rangeColor[rng]}">${rangeLabel[rng]}</span>`;
  warn.classList.add("hidden");
  wizard.glucoseConfirmed = false;
}

$("reading-glucose").addEventListener("input", updateGlucosePreview);

function needsGlucoseConfirm(g) {
  return g < 50 || g > 400;
}

$("glucose-next").onclick = () => {
  const g = parseGlucose();
  const err = $("glucose-error");
  err.classList.add("hidden");
  if (g == null || g < GLUCOSE_MIN || g > GLUCOSE_MAX) {
    err.textContent = `Enter a whole number between ${GLUCOSE_MIN} and ${GLUCOSE_MAX}.`;
    err.classList.remove("hidden");
    $("reading-glucose").focus();
    return;
  }
  if (needsGlucoseConfirm(g) && !wizard.glucoseConfirmed) {
    $("glucose-warn-text").textContent = `${g} looks unusual. Is that what your meter showed?`;
    $("glucose-warn").classList.remove("hidden");
    return;
  }
  wizard.glucose = g;
  advanceWizard();
};

$("glucose-fix").onclick = () => {
  $("glucose-warn").classList.add("hidden");
  $("reading-glucose").focus();
  $("reading-glucose").select();
};

$("glucose-confirm").onclick = () => {
  wizard.glucoseConfirmed = true;
  wizard.glucose = parseGlucose();
  $("glucose-warn").classList.add("hidden");
  advanceWizard();
};

function clearInsulinSelection() {
  document.querySelectorAll("#insulin-grid .unit-btn").forEach((b) => b.classList.remove("active"));
}

document.querySelectorAll("#insulin-grid .unit-btn").forEach((btn) => {
  btn.onclick = () => {
    clearInsulinSelection();
    btn.classList.add("active");
    const val = btn.dataset.units;
    if (val === "other") {
      $("insulin-custom-field").classList.remove("hidden");
      $("reading-insulin-custom").value = "";
      setTimeout(() => $("reading-insulin-custom").focus(), 50);
      wizard.insulin = null;
    } else {
      $("insulin-custom-field").classList.add("hidden");
      wizard.insulin = val === "" ? null : Number(val);
    }
  };
});

function parseInsulin() {
  const usingCustom = !$("insulin-custom-field").classList.contains("hidden");
  if (usingCustom) {
    const v = $("reading-insulin-custom").value.trim();
    if (v === "") return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return n;
  }
  const picked = document.querySelector("#insulin-grid .unit-btn.active");
  if (!picked) return undefined;
  const val = picked.dataset.units;
  return val === "" ? null : Number(val);
}

$("insulin-next").onclick = () => {
  const ins = parseInsulin();
  if (ins === undefined) {
    toast("Pick a button, or enter other units");
    return;
  }
  if (ins != null && (ins < 0 || ins > INSULIN_MAX)) {
    toast(`Insulin should be 0 to ${INSULIN_MAX} units`);
    return;
  }
  wizard.insulin = ins;
  advanceWizard();
};

$("food-skip").onclick = () => {
  wizard.food = "";
  advanceWizard();
};

$("food-next").onclick = () => {
  wizard.food = $("reading-food").value.trim();
  advanceWizard();
};

function renderConfirmSummary() {
  const slot = wizard.slot;
  const isBed = slot === "bedtime";
  const insText = isBed ? null : (wizard.insulin == null ? "None" : `${wizard.insulin} units`);
  $("confirm-summary").innerHTML = `
    <div class="confirm-row"><span class="confirm-label">Check-in</span><span class="confirm-value">${slotLabel[slot]}</span></div>
    <div class="confirm-row"><span class="confirm-label">Blood sugar</span><span class="confirm-value confirm-big">${wizard.glucose} mg/dL</span></div>
    ${insText != null ? `<div class="confirm-row"><span class="confirm-label">Insulin</span><span class="confirm-value">${insText}</span></div>` : ""}
    ${!isBed && wizard.food ? `<div class="confirm-row"><span class="confirm-label">Food</span><span class="confirm-value">${escape(wizard.food)}</span></div>` : ""}
    <div class="confirm-row"><span class="confirm-label">Time</span><span class="confirm-value">${fmtTime($("reading-time").value)}</span></div>`;
}

$("reading-save").onclick = async () => {
  const slot = wizard.slot;
  if (!slot || wizard.glucose == null) return showErr("Something went wrong — go back and try again");
  const body = {
    date: $("reading-date").value,
    slot,
    time: $("reading-time").value,
    glucose: wizard.glucose,
    insulin_units: slot === "bedtime" ? null : wizard.insulin,
    food: slot === "bedtime" ? null : wizard.food || null,
  };
  try {
    await api("/api/reading", { method: "POST", body: JSON.stringify(body) });
    $("reading-modal").classList.add("hidden");
    toast("Reading saved");
    refresh();
  } catch (e) {
    showErr("Couldn't save. Try again.");
  }
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
      btn.classList.remove("quiet");
      btn.onclick = async () => { await api("/api/push/test", { method: "POST" }); toast("Test sent"); };
      status.textContent = "Reminders are on. You'll get a tap at 7am, 8am, 12pm, 6pm, and 8pm.";
      return;
    }
  }
  btn.classList.remove("hidden");
  btn.textContent = "Turn on notifications";
  btn.classList.add("quiet");
  btn.onclick = subscribePush;
  status.textContent = "";
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
