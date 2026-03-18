// Apply saved theme immediately
(function() {
  var saved = localStorage.getItem("theme_color");
  if (saved && saved !== "default") {
    document.body.classList.add("theme-" + saved);
  }
})();

/** TEMPORARY: site condo gate (replace with real auth later) */
const REGALIA_GATE_STORAGE_KEY = "regalia_site_unlocked";
const REGALIA_GATE_CONDO_ID_KEY = "regalia_gate_condo_id";
const REGALIA_GATE_CONDO_PASSCODE_KEY = "regalia_gate_condo_passcode";
const REGALIA_GATE_CONDO_NAME_KEY = "regalia_gate_condo_name";

const panels = Array.from(document.querySelectorAll(".panel"));
const views = new Map(panels.map((panel) => [panel.dataset.view, panel]));
const appRoot = document.querySelector(".app");

let activePanel;

function hydrateGateGreeting() {
  try {
    const condoName = String(sessionStorage.getItem(REGALIA_GATE_CONDO_NAME_KEY) || "").trim();
    const welcomeTitle = document.querySelector("[data-welcome-title]");
    const loginTitle = document.querySelector("[data-login-title]");
    if (condoName) {
      if (welcomeTitle) welcomeTitle.textContent = `Welcome ${condoName} Admin`;
      if (loginTitle) loginTitle.textContent = `Welcome ${condoName} Admin`;
    } else {
      if (welcomeTitle) welcomeTitle.textContent = "Welcome!";
      if (loginTitle) loginTitle.textContent = "Enter Account Details";
    }
  } catch (e) {}
}

// Hydrate immediately on page load (works on refresh).
hydrateGateGreeting();

(function initSiteGate() {
  const gate = views.get("gate");
  const welcome = views.get("welcome");
  let unlocked = false;
  try {
    unlocked = sessionStorage.getItem(REGALIA_GATE_STORAGE_KEY) === "1";
  } catch (e) {}

  if (unlocked && welcome) {
    if (gate) {
      gate.classList.remove("is-active");
      gate.classList.add("is-hidden");
    }
    welcome.classList.remove("is-hidden");
    welcome.classList.add("is-active");
    activePanel = welcome;
  } else if (gate) {
    if (welcome) {
      welcome.classList.remove("is-active");
      welcome.classList.add("is-hidden");
    }
    gate.classList.remove("is-hidden");
    gate.classList.add("is-active");
    activePanel = gate;
  } else {
    activePanel = welcome || panels[0];
  }
})();

if (appRoot) {
  window.requestAnimationFrame(() => {
    appRoot.classList.add("is-loaded");
  });
}

const setActivePanel = (viewName) => {
  const nextPanel = views.get(viewName);
  if (!nextPanel || nextPanel === activePanel) return;

  activePanel.classList.remove("is-active");
  activePanel.classList.add("is-hidden");

  nextPanel.classList.remove("is-hidden");
  void nextPanel.offsetWidth;
  nextPanel.classList.add("is-active");
  activePanel = nextPanel;

  const compactHeader = viewName !== "welcome" && viewName !== "gate";
  if (appRoot) {
    appRoot.classList.toggle("is-form-open", compactHeader);
  }
  document.body.classList.toggle("is-form-open", compactHeader);

  // Ensure greeting is up-to-date whenever panels change.
  hydrateGateGreeting();
};

document.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === "to-login") setActivePanel("login");
    if (action === "to-welcome") setActivePanel("welcome");
  }
});

const gateForm = document.querySelector("[data-gate-form]");
const gateError = document.querySelector("[data-gate-error]");
if (gateForm) {
  gateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (gateError) gateError.textContent = "";
    const input = gateForm.querySelector("[data-gate-input]");
    const raw = input ? String(input.value || "").trim() : "";
    if (!raw) {
      if (gateError) gateError.textContent = "Passcode is required.";
      if (input) input.focus();
      return;
    }
    // Temporary bypass (no condo selected). Admin login will still require condo gate.
    if (raw === "SUPERSECRETKEY") {
      try {
        sessionStorage.setItem(REGALIA_GATE_STORAGE_KEY, "1");
        sessionStorage.removeItem(REGALIA_GATE_CONDO_ID_KEY);
        sessionStorage.removeItem(REGALIA_GATE_CONDO_PASSCODE_KEY);
        sessionStorage.removeItem(REGALIA_GATE_CONDO_NAME_KEY);
      } catch (e) {}
      if (input) input.value = "";
      try { hydrateGateGreeting(); } catch (e) {}
      setActivePanel("welcome");
      return;
    }
    try {
      const response = await fetch("/api/gate/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ condominium_passcode: raw })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (gateError) gateError.textContent = (data && data.error) ? data.error : "Incorrect passcode. Try again.";
        if (input) input.focus();
        return;
      }
      try {
        sessionStorage.setItem(REGALIA_GATE_STORAGE_KEY, "1");
        if (data && data.condominium_id) sessionStorage.setItem(REGALIA_GATE_CONDO_ID_KEY, String(data.condominium_id));
        if (data && data.condominium_name) sessionStorage.setItem(REGALIA_GATE_CONDO_NAME_KEY, String(data.condominium_name));
        sessionStorage.setItem(REGALIA_GATE_CONDO_PASSCODE_KEY, raw);
      } catch (e) {}
      if (input) input.value = "";
      try { hydrateGateGreeting(); } catch (e) {}
      setActivePanel("welcome");
    } catch (e) {
      if (gateError) gateError.textContent = "Server error. Try again.";
    }
  });
}

document.querySelectorAll("[data-toggle='password']").forEach((button) => {
  button.addEventListener("click", () => {
    const targetId = button.getAttribute("data-target");
    const input = document.getElementById(targetId);
    if (!input) return;

    const nextType = input.type === "password" ? "text" : "password";
    input.type = nextType;
    button.textContent = nextType === "password" ? "Show" : "Hide";
  });
});
//Login
const loginForm = document.querySelector("[data-login-form]");
const loginError = document.querySelector("[data-login-error]");

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (loginError) loginError.textContent = "";

    const formData = new FormData(loginForm);
    const username = String(formData.get("login") || "").trim();
    const password = String(formData.get("password") || "").trim();
    let condominium_passcode = "";
    let condominium_id = null;
    try {
      condominium_passcode = String(sessionStorage.getItem(REGALIA_GATE_CONDO_PASSCODE_KEY) || "").trim();
      const rawId = String(sessionStorage.getItem(REGALIA_GATE_CONDO_ID_KEY) || "").trim();
      condominium_id = rawId ? Number(rawId) : null;
    } catch (e) {}

    // Offline accounts for local development
    const offlineAccounts = {
      admin: { password: "admin123", role: "ADMIN", employee: { full_name: "Admin (Offline)", username: "admin", employee_id: 1 } },
      owner: { password: "owner123", role: "OWNER", employee: { full_name: "Unit Owner (Offline)", username: "owner", employee_id: 2 } },
      staff: { password: "staff123", role: "Front Desk", employee: { full_name: "Staff (Offline)", username: "staff" } }
    };
    const offlineMatch = offlineAccounts[username];
    if (offlineMatch && offlineMatch.password === password) {
      localStorage.setItem("token", "offline-token");
      localStorage.setItem("role", offlineMatch.role);
      localStorage.setItem("employee", JSON.stringify(offlineMatch.employee));
      const n = String(offlineMatch.role || "").toUpperCase().replace(/[\s_-]/g, "");
      if (n === "ADMIN") window.location.href = "./admin/index.html";
      else if (n === "OWNER") window.location.href = "./owner/index.html";
      else window.location.href = "./staff/index.html";
      return;
    }

    try {
      const response = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, condominium_passcode, condominium_id })
      });

      const data = await response.json();

      if (response.ok) {
        console.log("Login successful:", data);
        localStorage.setItem("token", data.token);
        if (data.role) localStorage.setItem("role", data.role);
        if (data.employee) localStorage.setItem("employee", JSON.stringify(data.employee));
        // Only set theme from server if user has no saved preference (preserves last chosen theme across logins)
        if (!localStorage.getItem("theme_color") && data.theme_color) {
          localStorage.setItem("theme_color", data.theme_color);
        }

        const roleKey = String(data.role || "").toUpperCase().replace(/[\s_-]/g, "");
        if (roleKey === "ADMIN") window.location.href = "./admin/index.html";
        else if (roleKey === "OWNER") window.location.href = "./owner/index.html";
        else if (data.role === "Admin" || data.role === "Front Desk" || data.role === "Property Manager" || data.role === "Security" || data.role === "Maintenance")
          window.location.href = "./staff/index.html";
        else window.location.href = "./staff/index.html";
      } else {
        if (loginError) loginError.textContent = data.error || "Login failed";
      }
    } catch (err) {
      console.error(err);
      if (loginError) loginError.textContent = "Server error. Try again later.";
    }
  });
}

