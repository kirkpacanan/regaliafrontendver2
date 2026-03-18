// Apply saved theme immediately
(function() {
  var saved = localStorage.getItem("theme_color");
  if (saved && saved !== "default") {
    document.body.classList.add("theme-" + saved);
  }
})();

/** TEMPORARY: hardcoded site gate for deployment & pitching — replace with real auth */
const REGALIA_SITE_PASSCODE = "SUPERSECRETKEY";
const REGALIA_GATE_STORAGE_KEY = "regalia_site_unlocked";

const panels = Array.from(document.querySelectorAll(".panel"));
const views = new Map(panels.map((panel) => [panel.dataset.view, panel]));
const appRoot = document.querySelector(".app");

let activePanel;

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
};

document.addEventListener("click", (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (actionButton) {
    const action = actionButton.dataset.action;
    if (action === "to-signup") setActivePanel("signup");
    if (action === "to-login") setActivePanel("login");
    if (action === "to-welcome") setActivePanel("welcome");
  }
});

const gateForm = document.querySelector("[data-gate-form]");
const gateError = document.querySelector("[data-gate-error]");
if (gateForm) {
  gateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (gateError) gateError.textContent = "";
    const input = gateForm.querySelector("[data-gate-input]");
    const raw = input ? String(input.value || "").trim() : "";
    if (raw === REGALIA_SITE_PASSCODE) {
      try {
        sessionStorage.setItem(REGALIA_GATE_STORAGE_KEY, "1");
      } catch (e) {}
      if (input) input.value = "";
      setActivePanel("welcome");
    } else {
      if (gateError) gateError.textContent = "Incorrect passcode. Try again.";
      if (input) input.focus();
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
//Signup
const signupForm = document.querySelector("[data-signup-form]");
const signupError = document.querySelector("[data-signup-error]");

if (signupForm) {
  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (signupError) signupError.textContent = "";

    const formData = new FormData(signupForm);

    const payload = {
    full_name: String(formData.get("full_name") || "").trim(),
    username: String(formData.get("username") || "").trim(),
    password: String(formData.get("password") || "").trim(),
    contact_number: String(formData.get("contact_number") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    address: String(formData.get("address") || "").trim()  // <-- added
    };


    try {
      const response = await fetch("/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (response.ok) {
        alert("Signup successful!");
        console.log(data);

        // Optional: auto switch to login panel
        setActivePanel("login");
      } else {
        if (signupError) signupError.textContent = data.error || "Signup failed";
      }
    } catch (err) {
      console.error(err);
      if (signupError) signupError.textContent = "Server error. Try again.";
    }
  });
}

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

    // Offline accounts for local development
    const offlineAccounts = {
      admin: { password: "admin123", role: "OWNER", employee: { full_name: "Admin (Offline)", username: "admin" } },
      staff:  { password: "staff123", role: "Front Desk", employee: { full_name: "Staff (Offline)", username: "staff" } }
    };
    const offlineMatch = offlineAccounts[username];
    if (offlineMatch && offlineMatch.password === password) {
      localStorage.setItem("token", "offline-token");
      localStorage.setItem("role", offlineMatch.role);
      localStorage.setItem("employee", JSON.stringify(offlineMatch.employee));
      window.location.href = offlineMatch.role === "OWNER" ? "./admin/index.html" : "./staff/index.html";
      return;
    }

    try {
      const response = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
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

        // Redirect based on role: OWNER → admin panel; staff roles → staff area
        if (data.role === "OWNER") {
          window.location.href = "./admin/index.html";
        } else if (data.role === "Admin" || data.role === "Front Desk" || data.role === "Property Manager" || data.role === "Security" || data.role === "Maintenance") {
          window.location.href = "./staff/index.html";
        } else {
          window.location.href = "./staff/index.html"; // fallback for any other role
        }
      } else {
        if (loginError) loginError.textContent = data.error || "Login failed";
      }
    } catch (err) {
      console.error(err);
      if (loginError) loginError.textContent = "Server error. Try again later.";
    }
  });
}

