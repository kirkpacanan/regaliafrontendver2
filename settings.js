const SETTINGS_KEY = "regalia.settings";

const DEFAULT_SETTINGS = {
  teal: "#1e9db1",
  green: "#7acb59",
  font: "Poppins",
};

const loadSettings = () => {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

const saveSettings = (settings) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};

const applySettings = (settings) => {
  const root = document.documentElement;
  root.style.setProperty("--teal", settings.teal);
  root.style.setProperty("--green", settings.green);
  root.style.setProperty("--font-family", settings.font);
};

const initSettingsUI = () => {
  const modal = document.querySelector("[data-settings-modal]");
  const openers = document.querySelectorAll("[data-open-settings]");
  const closeBtn = document.querySelector("[data-close-settings]");
  const saveBtn = document.querySelector("[data-save-settings]");
  const resetBtn = document.querySelector("[data-reset-settings]");
  const tealInput = document.querySelector("[data-setting-teal]");
  const greenInput = document.querySelector("[data-setting-green]");
  const fontSelect = document.querySelector("[data-setting-font]");
  const presetButtons = document.querySelectorAll("[data-preset]");

  if (!modal) return;

  const settings = loadSettings();
  if (tealInput) tealInput.value = settings.teal;
  if (greenInput) greenInput.value = settings.green;
  if (fontSelect) fontSelect.value = settings.font;

  const openModal = (event) => {
    if (event) event.preventDefault();
    modal.classList.add("is-open");
  };
  const closeModal = () => modal.classList.remove("is-open");

  openers.forEach((opener) => opener.addEventListener("click", openModal));
  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeModal();
  });

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const next = {
        teal: tealInput?.value || DEFAULT_SETTINGS.teal,
        green: greenInput?.value || DEFAULT_SETTINGS.green,
        font: fontSelect?.value || DEFAULT_SETTINGS.font,
      };
      saveSettings(next);
      applySettings(next);
      closeModal();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (tealInput) tealInput.value = DEFAULT_SETTINGS.teal;
      if (greenInput) greenInput.value = DEFAULT_SETTINGS.green;
      if (fontSelect) fontSelect.value = DEFAULT_SETTINGS.font;
      saveSettings({ ...DEFAULT_SETTINGS });
      applySettings({ ...DEFAULT_SETTINGS });
    });
  }

  presetButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const teal = button.getAttribute("data-preset-teal");
      const green = button.getAttribute("data-preset-green");
      if (tealInput && teal) tealInput.value = teal;
      if (greenInput && green) greenInput.value = green;
    });
  });
};

document.addEventListener("DOMContentLoaded", () => {
  const settings = loadSettings();
  applySettings(settings);
  initSettingsUI();
});
