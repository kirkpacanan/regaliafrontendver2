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
      const response = await fetch("https://regalia-eon6.onrender.com/signup", {
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

    try {
      const response = await fetch("https://regalia-eon6.onrender.com/login", {  // your backend URL
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });

      const data = await response.json();

      if (response.ok) {
        console.log("Login successful:", data);
        // You can save JWT token to localStorage if needed
        localStorage.setItem("token", data.token);

        // Redirect based on role
        if (data.role === "OWNER") window.location.href = "./owner/index.html";
        else window.location.href = "./dashboard.html"; // default page
      } else {
        if (loginError) loginError.textContent = data.error || "Login failed";
      }
    } catch (err) {
      console.error(err);
      if (loginError) loginError.textContent = "Server error. Try again later.";
    }
  });
}

