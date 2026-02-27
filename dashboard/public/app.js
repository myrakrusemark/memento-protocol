/* Hifathom Analytics — Frontend Logic */
/* global Chart */

const $ = (sel) => document.querySelector(sel);
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let charts = {};
let refreshTimer = null;

// ─── Auth ────────────────────────────────────────────────────────────────────

async function login(username, password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Login failed (${res.status})`);
  }

  showDashboard();
  loadStats();
  loadInboxData();
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  showLogin();
}

function showLogin() {
  $("#login-view").hidden = false;
  $("#dashboard-view").hidden = true;
  $("#top-tabs").hidden = true;
  clearInterval(refreshTimer);
}

function showDashboard() {
  $("#login-view").hidden = true;
  $("#dashboard-view").hidden = false;
  $("#dashboard-view").style.display = "flex";
  $("#top-tabs").hidden = false;
}

// ─── Top-Level Tabs ──────────────────────────────────────────────────────────

document.querySelectorAll(".top-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".top-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".top-pane").forEach((p) => { p.hidden = true; });
    btn.classList.add("active");
    const pane = $(`#pane-${btn.dataset.topTab}`);
    pane.hidden = false;

    // Chart.js can't size canvases in hidden containers — resize on reveal
    if (btn.dataset.topTab === "memento") {
      Object.values(charts).forEach((c) => c.resize());
    }
  });
});

// ─── Collapsible Sections ────────────────────────────────────────────────────

document.querySelectorAll(".collapsible").forEach((header) => {
  header.addEventListener("click", () => {
    header.classList.toggle("collapsed");
    const target = document.getElementById(header.dataset.target);
    target.hidden = !target.hidden;
  });
});

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadInboxData() {
  try {
    const res = await fetch("/api/messages");
    if (!res.ok) return;
    const { contacts, subscribers } = await res.json();
    renderContactTab(contacts);
    renderEmailTab(subscribers);
  } catch { /* non-fatal */ }
}

function renderContactTab(contacts) {
  const count = contacts.length;
  $("#contact-count-header").textContent = count || "";
  const list = $("#contact-list");
  if (!count) {
    list.innerHTML = `<p class="inbox-empty">No messages yet.</p>`;
    return;
  }
  list.innerHTML = contacts.map((c) => `
    <div class="inbox-row">
      <div class="inbox-meta">
        <span class="inbox-name">${esc(c.name || "Unknown")}</span>
        <span class="inbox-time">${formatTimestamp(c.timestamp)}</span>
      </div>
      <div class="inbox-body">${esc(c.message || "")}</div>
    </div>
  `).join("");
}

function renderEmailTab(subscribers) {
  const count = subscribers.length;
  $("#email-count-header").textContent = count || "";
  const list = $("#email-list");
  if (!count) {
    list.innerHTML = `<p class="inbox-empty">No subscribers yet.</p>`;
    return;
  }
  list.innerHTML = subscribers.map((s) => `
    <div class="inbox-row">
      <div class="inbox-meta">
        <span class="inbox-name">${esc(s.email || "")}</span>
        <span class="inbox-time">${formatTimestamp(s.timestamp)}</span>
      </div>
    </div>
  `).join("");
}

async function loadStats() {
  const loading = $("#loading");
  const dashboard = $("#dashboard");

  loading.hidden = false;
  dashboard.hidden = true;

  try {
    const res = await fetch("/api/stats");
    if (res.status === 401) {
      showLogin();
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    renderDashboard(data);

    loading.hidden = true;
    dashboard.hidden = false;

    $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;

    // Schedule auto-refresh
    clearInterval(refreshTimer);
    refreshTimer = setInterval(loadStats, REFRESH_INTERVAL_MS);
  } catch (err) {
    loading.textContent = `Error: ${err.message}`;
    console.error("Stats load failed:", err);
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderDashboard(data) {
  // Overview cards
  $("#stat-users").textContent = data.overview.users.toLocaleString();
  $("#stat-workspaces").textContent = data.overview.workspaces.toLocaleString();
  $("#stat-memories").textContent = data.overview.memories.toLocaleString();
  $("#stat-active").textContent = data.overview.activeUsers7d.toLocaleString();

  // Charts
  renderSignupsChart(data.signups);
  renderPlansChart(data.plans);
  renderGrowthChart(data.memoryGrowth);
  renderTypesChart(data.memoryTypes);

  // Table
  renderWorkspacesTable(data.workspaces);
}

// Chart.js global config
Chart.defaults.color = "#8b8fa3";
Chart.defaults.borderColor = "#2a2e3d";
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";

function renderSignupsChart(signups) {
  const ctx = $("#chart-signups");
  if (charts.signups) charts.signups.destroy();

  charts.signups = new Chart(ctx, {
    type: "line",
    data: {
      labels: signups.map((s) => formatDay(s.day)),
      datasets: [{
        label: "Signups",
        data: signups.map((s) => s.count),
        borderColor: "#6c5ce7",
        backgroundColor: "rgba(108, 92, 231, 0.1)",
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1 } },
        x: { ticks: { maxTicksLimit: 8 } },
      },
    },
  });
}

function renderPlansChart(plans) {
  const ctx = $("#chart-plans");
  if (charts.plans) charts.plans.destroy();

  const labels = Object.keys(plans);
  const values = Object.values(plans);
  const colors = labels.map((l) => l === "full" ? "#6c5ce7" : "#2d3748");

  charts.plans = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: labels.map((l) => l.charAt(0).toUpperCase() + l.slice(1)),
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: "#1a1d27",
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: "bottom" },
      },
    },
  });
}

function renderGrowthChart(growth) {
  const ctx = $("#chart-growth");
  if (charts.growth) charts.growth.destroy();

  charts.growth = new Chart(ctx, {
    type: "line",
    data: {
      labels: growth.map((g) => formatDay(g.day)),
      datasets: [{
        label: "Memories",
        data: growth.map((g) => g.count),
        borderColor: "#00cec9",
        backgroundColor: "rgba(0, 206, 201, 0.1)",
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true },
        x: { ticks: { maxTicksLimit: 8 } },
      },
    },
  });
}

function renderTypesChart(types) {
  const ctx = $("#chart-types");
  if (charts.types) charts.types.destroy();

  const labels = Object.keys(types);
  const values = Object.values(types);
  const colors = ["#6c5ce7", "#00cec9", "#fdcb6e", "#74b9ff", "#ff7675"];

  charts.types = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels.map((l) => l.charAt(0).toUpperCase() + l.slice(1)),
      datasets: [{
        label: "Count",
        data: values,
        backgroundColor: colors.slice(0, labels.length),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true },
      },
    },
  });
}

function renderWorkspacesTable(workspaces) {
  const tbody = $("#workspaces-table tbody");
  tbody.innerHTML = "";

  // Sort by memory count descending
  const sorted = [...workspaces].sort((a, b) => b.memories - a.memories);

  for (const ws of sorted) {
    const tr = document.createElement("tr");
    const planClass = ws.plan === "full" ? "badge-full" : "badge-free";
    tr.innerHTML = `
      <td>${esc(ws.name)}</td>
      <td>${esc(ws.email)}</td>
      <td><span class="badge ${planClass}">${esc(ws.plan || "free")}</span></td>
      <td>${ws.memories.toLocaleString()}</td>
      <td>${ws.items.toLocaleString()}</td>
      <td>${ws.lastActive ? formatTimestamp(ws.lastActive) : "—"}</td>
    `;
    tbody.appendChild(tr);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDay(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d)) return ts;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function esc(str) {
  if (!str) return "";
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

// ─── Event Handlers ──────────────────────────────────────────────────────────

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#login-error");
  err.hidden = true;

  try {
    await login($("#username").value, $("#password").value);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$("#logout-btn").addEventListener("click", logout);
$("#refresh-btn").addEventListener("click", loadStats);

// ─── Init ────────────────────────────────────────────────────────────────────

// Check if already authenticated by trying to fetch stats
(async function init() {
  try {
    const res = await fetch("/api/stats");
    if (res.ok) {
      showDashboard();
      const data = await res.json();
      renderDashboard(data);
      $("#loading").hidden = true;
      $("#dashboard").hidden = false;
      $("#last-updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
      refreshTimer = setInterval(loadStats, REFRESH_INTERVAL_MS);
      loadInboxData();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
