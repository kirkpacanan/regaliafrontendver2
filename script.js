const panels = Array.from(document.querySelectorAll(".panel"));
const views = new Map(panels.map((panel) => [panel.dataset.view, panel]));
const appRoot = document.querySelector(".app");

let activePanel = views.get("welcome");

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

  if (appRoot) {
    appRoot.classList.toggle("is-form-open", viewName !== "welcome");
  }
  document.body.classList.toggle("is-form-open", viewName !== "welcome");
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

const loginForm = document.querySelector("[data-login-form]");
const loginError = document.querySelector("[data-login-error]");

if (loginForm) {
  loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (loginError) loginError.textContent = "";

    const formData = new FormData(loginForm);
    const login = String(formData.get("login") || "").trim().toLowerCase();
    const password = String(formData.get("password") || "").trim();

    if (login === "admin" && password === "admin123") {
      window.location.href = "./admin/index.html";
      return;
    }

    if (login === "staff" && password === "staff123") {
      window.location.href = "./staff/index.html";
      return;
    }

    if (loginError) {
      loginError.textContent = "Invalid login. Try admin/admin123 or staff/staff123.";
    }
  });
}
