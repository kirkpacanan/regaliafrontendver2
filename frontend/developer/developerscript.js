const STORAGE = {
  master: "regalia_dev_master_passcode",
  token: "regalia_dev_token",
  employee: "regalia_dev_employee",
  tab: "regalia_dev_tab",
};

const views = {
  gate: document.querySelector('[data-view="gate"]'),
  login: document.querySelector('[data-view="login"]'),
  appPanels: Array.from(document.querySelectorAll('[data-view="app"][data-panel]')),
};

const logoutBtn = document.querySelector('[data-action="logout"]');
const refreshBtn = document.querySelector('[data-action="refresh"]');
const sessionLabel = document.querySelector("[data-session-label]");
const devnav = document.querySelector("[data-devnav]");
const devtabs = Array.from(document.querySelectorAll("[data-tab]"));

let selectedAdminId = null;

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

function getTab() {
  try {
    return localStorage.getItem(STORAGE.tab) || "condos";
  } catch (e) {
    return "condos";
  }
}

function setTab(v) {
  try {
    localStorage.setItem(STORAGE.tab, v);
  } catch (e) {}
}

async function activateTab(tab) {
  const next = tab || "condos";
  setTab(next);
  views.appPanels.forEach((p) => {
    p.hidden = p.getAttribute("data-panel") !== next;
  });
  devtabs.forEach((b) => {
    b.classList.toggle("is-active", b.getAttribute("data-tab") === next);
  });

  // Lazy refresh based on section
  if (next === "condos" || next === "create-admin") {
    await loadCondominiums().catch(() => {});
  }
  if (next === "tracking") {
    await refreshTracking().catch(() => {});
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
  if (views.appPanels && views.appPanels.length) {
    const shouldShowApp = !!master && !!token;
    views.appPanels.forEach((p) => (p.hidden = !shouldShowApp));
  }
  show(devnav, !!master && !!token);

  const grid = document.querySelector(".grid");
  if (grid) {
    const mode = !master ? "gate" : (!token ? "login" : "app");
    grid.setAttribute("data-layout", mode);
  }

  if (logoutBtn) logoutBtn.hidden = !token;

  const emp = getEmployee();
  if (sessionLabel) {
    sessionLabel.textContent = emp && emp.username ? `Signed in as ${emp.username}` : "";
  }

  if (master && token) {
    activateTab(getTab());
  }
}

async function loadCondominiums() {
  const select = document.querySelector("[data-condo-select]");
  const list = document.querySelector("[data-condo-list]");
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

  if (list) {
    list.innerHTML = "";
    condos.forEach((c) => {
      const item = document.createElement("div");
      item.className = "list-item";
      const id = Number(c.condominium_id);
      const createdAt = c.created_at ? new Date(c.created_at).toLocaleString() : "";
      item.innerHTML = `
        <div class="list-item__left">
          <div class="list-item__title">${escapeHtml(c.name || "Condominium")}</div>
          <div class="list-item__meta">${escapeHtml(createdAt)}</div>
        </div>
        <div>
          <button class="btn ghost" type="button" data-action="delete-condo" data-condo-id="${id}">Delete</button>
        </div>
      `;
      list.appendChild(item);
    });
  }
}

function renderAdmins(rows) {
  const tbody = document.querySelector("[data-admins-tbody]");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!rows || rows.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = '<td class="muted" colspan="5">No admins created yet.</td>';
    tbody.appendChild(tr);
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const adminLabel = `${r.full_name || "Admin"}${r.username ? ` (@${r.username})` : ""}`;
    const adminId = Number(r.employee_id);
    tr.setAttribute("data-admin-row", "1");
    tr.setAttribute("data-admin-id", String(adminId));
    tr.style.cursor = "pointer";
    tr.innerHTML = `
      <td>${escapeHtml(adminLabel)}</td>
      <td>${escapeHtml(r.condominium_name || "-")}</td>
      <td>${Number(r.ownersCreatedCount || 0)}</td>
      <td>${Number(r.staffCreatedCount || 0)}</td>
      <td>
        <div class="table-actions">
          <button class="btn ghost btn-small" type="button" data-action="reset-admin" data-admin-id="${adminId}">Reset passcode</button>
          <button class="btn ghost btn-small" type="button" data-action="delete-admin" data-admin-id="${adminId}">Delete</button>
        </div>
      </td>
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

function renderPeople(container, people, kind) {
  if (!container) return;
  container.innerHTML = "";
  if (!people || people.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted small";
    empty.textContent = kind === "owners" ? "No owners yet." : "No staff yet.";
    container.appendChild(empty);
    return;
  }
  people.forEach((p) => {
    const el = document.createElement("div");
    el.className = "person";
    el.setAttribute("data-person-id", String(p.employee_id));
    const metaBits = [];
    if (p.username) metaBits.push(`@${p.username}`);
    if (p.email) metaBits.push(p.email);
    el.innerHTML = `
      <div class="person__top">
        <div>
          <div class="person__name">${escapeHtml(p.full_name || "User")}</div>
          <div class="person__meta">${escapeHtml(metaBits.join(" • "))}</div>
          <div class="person__role">${escapeHtml(p.role_type || "")}</div>
        </div>
        <div class="person__actions">
          <button class="btn ghost btn-small" type="button" data-action="person-edit" data-user-id="${p.employee_id}">Edit</button>
          <button class="btn ghost btn-small" type="button" data-action="person-reset" data-user-id="${p.employee_id}">Reset</button>
          <button class="btn ghost btn-small" type="button" data-action="person-delete" data-user-id="${p.employee_id}">Delete</button>
        </div>
      </div>
      <div class="person__edit">
        <label class="field">
          <span>Username</span>
          <input type="text" name="username" value="${escapeHtml(p.username || "")}" />
        </label>
        <label class="field">
          <span>Email</span>
          <input type="email" name="email" value="${escapeHtml(p.email || "")}" />
        </label>
        <label class="field">
          <span>Contact number</span>
          <input type="text" name="contact_number" value="${escapeHtml(p.contact_number || "")}" />
        </label>
        <label class="field">
          <span>Address</span>
          <input type="text" name="address" value="${escapeHtml(p.address || "")}" />
        </label>
        <label class="field">
          <span>New passcode (optional)</span>
          <input type="password" name="password" value="" />
        </label>
        <div class="row">
          <div class="error" data-person-error></div>
          <button class="btn primary btn-small" type="button" data-action="person-save" data-user-id="${p.employee_id}">Save</button>
          <button class="btn outline btn-small" type="button" data-action="person-cancel" data-user-id="${p.employee_id}">Cancel</button>
        </div>
      </div>
    `;
    container.appendChild(el);
  });
}

async function loadAdminTree(adminId) {
  const tree = document.querySelector("[data-tree]");
  const title = document.querySelector("[data-tree-title]");
  const subtitle = document.querySelector("[data-tree-subtitle]");
  const ownersEl = document.querySelector("[data-tree-owners]");
  const staffEl = document.querySelector("[data-tree-staff]");
  const treeError = document.querySelector("[data-tree-error]");
  const refreshTreeBtn = document.querySelector("[data-action='tree-refresh']");

  selectedAdminId = adminId;
  if (refreshTreeBtn) refreshTreeBtn.disabled = !adminId;
  setError(treeError, "");

  if (!adminId) {
    show(tree, false);
    return;
  }

  show(tree, true);
  if (title) title.textContent = "Loading…";
  if (subtitle) subtitle.textContent = "";
  if (ownersEl) ownersEl.innerHTML = "";
  if (staffEl) staffEl.innerHTML = "";

  try {
    const data = await api(`/api/developer/admins/${adminId}/tree`, { method: "GET" });
    if (title) title.textContent = "Account tree";
    if (subtitle) subtitle.textContent = `Admin ID: ${adminId}`;
    renderPeople(ownersEl, data.owners || [], "owners");
    renderPeople(staffEl, data.staff || [], "staff");
  } catch (e) {
    if (title) title.textContent = "Account tree";
    setError(treeError, e.message || "Failed to load tree");
  }
}

document.addEventListener("click", async (event) => {
  // Show/hide passcode inputs
  const toggle = event.target && event.target.closest && event.target.closest("[data-toggle='passcode']");
  if (toggle) {
    const wrap = toggle.closest(".field") || toggle.parentElement;
    const input = wrap ? wrap.querySelector("input") : null;
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
    toggle.textContent = input.type === "password" ? "Show" : "Hide";
    return;
  }

  // Select admin row (ignore clicks on action buttons)
  const row = event.target && event.target.closest && event.target.closest("tr[data-admin-row='1']");
  if (row) {
    const isAction = event.target.closest && event.target.closest("[data-action][data-admin-id]");
    if (!isAction) {
      const adminId = Number(row.getAttribute("data-admin-id"));
      await loadAdminTree(adminId);
      return;
    }
  }

  const btn = event.target && event.target.closest && event.target.closest("[data-action][data-admin-id]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  const adminId = Number(btn.getAttribute("data-admin-id"));
  if (!adminId) return;

  if (action === "delete-admin") {
    const ok = window.confirm("Delete this admin account? This cannot be undone.");
    if (!ok) return;
    try {
      await api(`/api/developer/admins/${adminId}`, { method: "DELETE" });
      await refreshTracking();
    } catch (e) {
      const trackError = document.querySelector("[data-track-error]");
      setError(trackError, e.message || "Failed to delete admin");
    }
  }

  if (action === "reset-admin") {
    const ok = window.confirm("Reset this admin passcode? The new passcode will be shown once.");
    if (!ok) return;
    try {
      const data = await api(`/api/developer/admins/${adminId}/reset-passcode`, { method: "POST", body: JSON.stringify({}) });
      window.alert(`New admin passcode: ${data.new_passcode}`);
    } catch (e) {
      const trackError = document.querySelector("[data-track-error]");
      setError(trackError, e.message || "Failed to reset admin passcode");
    }
  }
});

document.addEventListener("click", async (event) => {
  const btn = event.target && event.target.closest && event.target.closest("[data-action][data-user-id]");
  if (!btn) return;
  const action = btn.getAttribute("data-action");
  const userId = Number(btn.getAttribute("data-user-id"));
  if (!userId) return;

  const person = btn.closest(".person");
  const personErr = person ? person.querySelector("[data-person-error]") : null;
  const setPersonErr = (m) => { if (personErr) personErr.textContent = m || ""; };

  if (action === "person-edit") {
    if (person) person.classList.add("is-editing");
    setPersonErr("");
    return;
  }
  if (action === "person-cancel") {
    if (person) person.classList.remove("is-editing");
    setPersonErr("");
    return;
  }
  if (action === "person-save") {
    if (!person) return;
    setPersonErr("");
    const payload = {};
    ["username", "email", "contact_number", "address", "password"].forEach((k) => {
      const input = person.querySelector(`input[name='${k}']`);
      if (input) payload[k] = String(input.value || "").trim();
    });
    if (!payload.password) delete payload.password;
    try {
      await api(`/api/developer/users/${userId}`, { method: "PUT", body: JSON.stringify(payload) });
      person.classList.remove("is-editing");
      await loadAdminTree(selectedAdminId);
      await refreshTracking().catch(() => {});
    } catch (e) {
      setPersonErr(e.message || "Failed to save");
    }
    return;
  }
  if (action === "person-reset") {
    const ok = window.confirm("Reset this user passcode? The new passcode will be shown once.");
    if (!ok) return;
    try {
      const data = await api(`/api/developer/users/${userId}/reset-passcode`, { method: "POST", body: JSON.stringify({}) });
      window.alert(`New passcode: ${data.new_passcode}`);
      await loadAdminTree(selectedAdminId);
    } catch (e) {
      setPersonErr(e.message || "Failed to reset");
    }
    return;
  }
  if (action === "person-delete") {
    const ok = window.confirm("Delete this user? This cannot be undone.");
    if (!ok) return;
    try {
      await api(`/api/developer/users/${userId}`, { method: "DELETE" });
      await loadAdminTree(selectedAdminId);
      await refreshTracking().catch(() => {});
    } catch (e) {
      setPersonErr(e.message || "Failed to delete");
    }
    return;
  }
});

document.addEventListener("click", async (event) => {
  const btn = event.target && event.target.closest && event.target.closest("[data-action='delete-condo'][data-condo-id]");
  if (!btn) return;
  const condoId = Number(btn.getAttribute("data-condo-id"));
  if (!condoId) return;
  const ok = window.confirm("Delete this condominium? This cannot be undone.");
  if (!ok) return;
  const condoError = document.querySelector("[data-condo-error]");
  setError(condoError, "");
  try {
    await api(`/api/developer/condominiums/${condoId}`, { method: "DELETE" });
    await loadCondominiums();
    await refreshTracking().catch(() => {});
  } catch (e) {
    setError(condoError, e.message || "Failed to delete condominium");
  }
});

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

// Tabs
if (devtabs && devtabs.length) {
  devtabs.forEach((b) => {
    b.addEventListener("click", async () => {
      const tab = b.getAttribute("data-tab");
      await activateTab(tab);
    });
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
      await activateTab(getTab());
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
    const passcode_confirm = String(fd.get("passcode_confirm") || "").trim();
    if (passcode !== passcode_confirm) {
      setError(condoError, "Passcodes do not match.");
      return;
    }
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
    const tab = getTab();
    if (tab === "tracking") await refreshTracking();
    else await loadCondominiums().catch(() => {});
  });
}

const treeRefreshBtn = document.querySelector("[data-action='tree-refresh']");
if (treeRefreshBtn) {
  treeRefreshBtn.addEventListener("click", async () => {
    if (!selectedAdminId) return;
    await loadAdminTree(selectedAdminId);
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
    await activateTab(getTab()).catch(() => {});
  }
})();

