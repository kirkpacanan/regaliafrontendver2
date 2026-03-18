const STORAGE = {
  master: "regalia_dev_master_passcode",
  token: "regalia_dev_token",
  employee: "regalia_dev_employee",
};

const views = {
  gate: document.querySelector('[data-view="gate"]'),
  login: document.querySelector('[data-view="login"]'),
  app: document.querySelector('[data-view="app"]'),
  tracking: document.querySelector('[data-view="tracking"]'),
};

const logoutBtn = document.querySelector('[data-action="logout"]');
const refreshBtn = document.querySelector('[data-action="refresh"]');
const sessionLabel = document.querySelector("[data-session-label]");

function show(el, yes) {
  if (!el) return;
  el.hidden = !yes;
}

function setError(target, msg) {
  if (target) target.textContent = msg || "";
}

function getMaster() {
  try {
    return localStorage.getItem(STORAGE.master) || "";
  } catch (e) {
    return "";
  }
}

function setMaster(v) {
  try {
    localStorage.setItem(STORAGE.master, v);
  } catch (e) {}
}

function getToken() {
  try {
    return localStorage.getItem(STORAGE.token) || "";
  } catch (e) {
    return "";
  }
}

function setToken(v) {
  try {
    if (v) localStorage.setItem(STORAGE.token, v);
    else localStorage.removeItem(STORAGE.token);
  } catch (e) {}
}

function setEmployee(emp) {
  try {
    if (emp) localStorage.setItem(STORAGE.employee, JSON.stringify(emp));
    else localStorage.removeItem(STORAGE.employee);
  } catch (e) {}
}

function getEmployee() {
  try {
    const raw = localStorage.getItem(STORAGE.employee);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

async function api(path, opts = {}) {
  const token = getToken();
  const headers = Object.assign({ "Content-Type": "application/json" }, opts.headers || {});
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data && data.error ? data.error : "Request failed");
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setUiState() {
  const master = getMaster();
  const token = getToken();

  show(views.gate, !master);
  show(views.login, !!master && !token);
  show(views.app, !!master && !!token);
  show(views.tracking, !!master && !!token);

  if (logoutBtn) logoutBtn.hidden = !token;

  const emp = getEmployee();
  if (sessionLabel) {
    sessionLabel.textContent = emp && emp.username ? `Signed in as ${emp.username}` : "";
  }
}

async function loadCondominiums() {
  const select = document.querySelector("[data-condo-select]");
  if (!select) return;
  const condos = await api("/api/developer/condominiums", { method: "GET" });
  const current = select.value;
  select.innerHTML = '<option value="" selected disabled>Select condominium</option>';
  condos.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = String(c.condominium_id);
    opt.textContent = c.name;
    select.appendChild(opt);
  });
  if (current) select.value = current;
}

function renderAdmins(rows) {
  const tbody = document.querySelector("[data-admins-tbody]");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td class="muted" colspan="4">No admins created yet.</td>';
    tbody.appendChild(tr);
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const adminLabel = `${r.full_name || "Admin"}${r.username ? ` (@${r.username})` : ""}`;
    tr.innerHTML = `
      <td>${escapeHtml(adminLabel)}</td>
      <td>${escapeHtml(r.condominium_name || "-")}</td>
      <td>${Number(r.ownersCreatedCount || 0)}</td>
      <td>${Number(r.staffCreatedCount || 0)}</td>
    `;
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refreshTracking() {
  const trackError = document.querySelector("[data-track-error]");
  setError(trackError, "");
  try {
    const rows = await api("/api/developer/admins", { method: "GET" });
    renderAdmins(rows);
  } catch (e) {
    setError(trackError, e.message || "Failed to load tracking");
  }
}

// Gate
const gateForm = document.querySelector("[data-gate-form]");
const gateError = document.querySelector("[data-gate-error]");
if (gateForm) {
  gateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    setError(gateError, "");
    const fd = new FormData(gateForm);
    const master = String(fd.get("master_passcode") || "").trim();
    if (!master) return setError(gateError, "Master passcode is required.");
    setMaster(master);
    setUiState();
  });
}

// Login
const loginForm = document.querySelector("[data-login-form]");
const loginError = document.querySelector("[data-login-error]");
if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(loginError, "");
    const fd = new FormData(loginForm);
    const username = String(fd.get("username") || "").trim();
    const password = String(fd.get("password") || "").trim();
    const master_passcode = getMaster();
    try {
      const data = await api("/api/developer/login", {
        method: "POST",
        body: JSON.stringify({ master_passcode, username, password }),
      });
      setToken(data.token);
      setEmployee(data.employee || null);
      setUiState();
      await loadCondominiums();
      await refreshTracking();
    } catch (e) {
      setError(loginError, e.message || "Login failed");
    }
  });
}

// Create condominium
const condoForm = document.querySelector("[data-condo-form]");
const condoError = document.querySelector("[data-condo-error]");
if (condoForm) {
  condoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(condoError, "");
    const fd = new FormData(condoForm);
    const name = String(fd.get("name") || "").trim();
    const passcode = String(fd.get("passcode") || "").trim();
    try {
      await api("/api/developer/condominiums", {
        method: "POST",
        body: JSON.stringify({ name, passcode }),
      });
      condoForm.reset();
      await loadCondominiums();
      setError(condoError, "");
    } catch (e) {
      setError(condoError, e.message || "Failed to create condominium");
    }
  });
}

// Create admin
const adminForm = document.querySelector("[data-admin-form]");
const adminError = document.querySelector("[data-admin-error]");
if (adminForm) {
  adminForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(adminError, "");
    const fd = new FormData(adminForm);
    const payload = {
      condominium_id: Number(fd.get("condominium_id")),
      condominium_passcode: String(fd.get("condominium_passcode") || "").trim(),
      full_name: String(fd.get("full_name") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      username: String(fd.get("username") || "").trim(),
      password: String(fd.get("password") || "").trim(),
      contact_number: String(fd.get("contact_number") || "").trim(),
      address: String(fd.get("address") || "").trim(),
    };
    try {
      await api("/api/developer/admins", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      adminForm.reset();
      await refreshTracking();
    } catch (e) {
      setError(adminError, e.message || "Failed to create admin");
    }
  });
}

// Change master passcode
const masterForm = document.querySelector("[data-master-form]");
const masterError = document.querySelector("[data-master-error]");
if (masterForm) {
  masterForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError(masterError, "");
    const fd = new FormData(masterForm);
    const current_passcode = String(fd.get("current_passcode") || "").trim();
    const new_passcode = String(fd.get("new_passcode") || "").trim();
    try {
      await api("/api/developer/master-passcode", {
        method: "POST",
        body: JSON.stringify({ current_passcode, new_passcode }),
      });
      masterForm.reset();
      setError(masterError, "Master passcode updated.");
      // Keep the local gate passcode aligned with the new value
      setMaster(new_passcode);
    } catch (e) {
      setError(masterError, e.message || "Failed to update passcode");
    }
  });
}

if (refreshBtn) {
  refreshBtn.addEventListener("click", async () => {
    await loadCondominiums().catch(() => {});
    await refreshTracking();
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    setToken("");
    setEmployee(null);
    setUiState();
  });
}

// Initial
(async function init() {
  setUiState();
  if (getToken()) {
    await loadCondominiums().catch(() => {});
    await refreshTracking().catch(() => {});
  }
})();

