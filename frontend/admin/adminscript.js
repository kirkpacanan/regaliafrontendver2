(function () {
  "use strict";

  var API = "/api";
  var page = document.body.getAttribute("data-page");

  if (page === "dashboard") {
    initDashboard();
  } else if (page === "properties") {
    initProperties();
  } else if (page === "employees") {
    initEmployees();
  } else if (page === "bookings") {
    initBookings();
  }

  function initDashboard() {
    var API = "/api";
    var emptyEl = document.querySelector("[data-dashboard-empty]");
    var listEl = document.querySelector("[data-dashboard-properties]");
    var totalBookingEl = document.querySelector("[data-dashboard-total-booking]");
    var availableEl = document.querySelector("[data-dashboard-available]");
    var occupiedEl = document.querySelector("[data-dashboard-occupied]");
    var totalPropEl = document.querySelector("[data-dashboard-total-properties]");
    function setStat(el, val) { if (el) el.textContent = val; }
    function esc(s) {
      if (s == null || s === undefined) return "";
      var d = document.createElement("div");
      d.textContent = String(s);
      return d.innerHTML;
    }
    function firstImg(unit) {
      var raw = unit && unit.image_urls;
      if (!raw) return null;
      try {
        var arr = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(arr) && arr.length) {
          var first = arr[0];
          return first && (typeof first === "string" ? first : first.url || first.src) ? first : null;
        }
      } catch (e) {}
      return null;
    }
    Promise.all([
      fetch(API + "/properties").then(function (r) { return r.ok ? r.json() : []; }),
      fetch(API + "/bookings").then(function (r) { return r.ok ? r.json() : []; })
    ]).then(function (results) {
      var data = results[0];
      var bookings = results[1] || [];
      var confirmed = bookings.filter(function (b) { return b.status === "confirmed"; }).length;
      setStat(totalBookingEl, bookings.length);
      setStat(totalPropEl, data.length);
      setStat(occupiedEl, confirmed);
      setStat(availableEl, Math.max(0, data.length - confirmed));
      if (emptyEl) emptyEl.style.display = data.length ? "none" : "block";
      if (!listEl) return;
      listEl.innerHTML = "";
      data.forEach(function (unit) {
        var card = document.createElement("div");
        card.className = "property-card property-card--employee-style";
        var imgSrc = firstImg(unit);
        var mediaHtml = "<div class=\"property-card__media\">";
        if (imgSrc) mediaHtml += "<img src=\"" + esc(imgSrc) + "\" alt=\"\" />";
        else mediaHtml += "<span class=\"property-card__placeholder\"></span>";
        mediaHtml += "</div>";
        var meta = [unit.unit_type, unit.unit_size ? unit.unit_size + " sqm" : ""].filter(Boolean).join(" · ") || "—";
        var priceLine = unit.price != null && unit.price !== "" ? " ₱ " + esc(String(unit.price)) : "";
        card.innerHTML =
          mediaHtml +
          "<div class=\"property-card__body\">" +
            "<h4 class=\"property-card__name\">" + esc(unit.unit_number || String(unit.unit_id)) + "</h4>" +
            "<p class=\"property-card__role\">" + esc(unit.tower_name || "—") + "</p>" +
            "<div class=\"property-card__meta\">" +
              "<span>" + esc(meta) + priceLine + "</span>" +
              "<span class=\"property-card__edit-label\">Edit details</span>" +
            "</div>" +
          "</div>";
        listEl.appendChild(card);
      });
    }).catch(function () {
      setStat(totalBookingEl, "0");
      setStat(availableEl, "0");
      setStat(occupiedEl, "0");
      setStat(totalPropEl, "0");
      if (emptyEl) emptyEl.style.display = "block";
      if (listEl) listEl.innerHTML = "";
    });
  }

  function initProperties() {
    var openBtn = document.querySelector("[data-open-modal]");
    var closeBtn = document.querySelector("[data-close-modal]");
    var overlay = document.querySelector("[data-modal]");
    var form = document.querySelector(".modal-form[data-step]");
    var steps = document.querySelectorAll(".form-step[data-step]");
    var nextBtn = document.querySelector("[data-next]");
    var prevBtn = document.querySelector("[data-prev]");
    var title = document.querySelector("[data-modal-title]");
    var propertiesList = document.querySelector("[data-properties]");
    var towerSelect = document.querySelector("[data-tower-select]");
    var newTowerFields = document.querySelector("[data-new-tower]");
    var updateSidebar = document.querySelector("[data-update-sidebar]");
    var updateContent = document.getElementById("editUnitSidebarContent");
    var updateCloseBtns = document.querySelectorAll("[data-close-update]");
    var updateTitle = document.querySelector("[data-update-title]");
    var bookingLinkInput = document.querySelector("[data-booking-link]");
    var saveUpdateBtn = document.querySelector("[data-save-update]");
    var copyBtn = document.querySelector("[data-copy-link]");
    var openLinkBtn = document.querySelector("[data-open-link]");
    var updateForm = document.querySelector("[data-update-form]");
    var deleteUnitBtn = document.querySelector("[data-delete-unit]");
    var propertyOverviewSidebar = document.querySelector("[data-property-overview-sidebar]");
    var propertyOverviewContent = document.getElementById("propertyOverviewSidebarContent");
    var propertyOverviewImg = document.getElementById("propertyOverviewImg");
    var propertyOverviewPlaceholder = document.getElementById("propertyOverviewPlaceholder");
    var propertyOverviewName = document.getElementById("propertyOverviewName");
    var propertyOverviewTower = document.getElementById("propertyOverviewTower");
    var propertyOverviewMeta = document.getElementById("propertyOverviewMeta");
    var propertyEditDetailsBtn = document.querySelector("[data-property-edit-details]");
    var propertyDeleteUnitBtn = document.querySelector("[data-property-delete-unit]");

    var properties = [];
    var towers = [];
    var currentStep = 1;
    var activeUnit = null;
    var selectedTowerIdOrNew = null; // "__new__" or number; set when leaving step 1
    var unitImageDataUrls = [null, null, null, null]; // base64 data URLs for 4 slots
    var updateImageDataUrls = [null, null, null, null]; // for edit modal

    function buildBookingLink(unit) {
      var base = window.location.origin + (window.location.pathname.indexOf("/admin") !== -1 ? "/admin" : "") + "/../guest/booking.html";
      return base.replace("/admin/../", "/") + "?unit_id=" + (unit.unit_id || unit.unit_number);
    }

    var totalSteps = 3; // Tower, Unit details, Images

    function setStep(step) {
      if (!form) return;
      currentStep = step;
      form.dataset.step = String(step);
      for (var i = 0; i < steps.length; i++) {
        steps[i].classList.toggle("is-active", steps[i].dataset.step === String(step));
      }
      if (prevBtn) prevBtn.disabled = step === 1;
      var isLast = step === totalSteps;
      if (nextBtn) nextBtn.textContent = isLast ? "Submit" : "Next";
      if (title) {
        var activePanel = document.querySelector(".form-step.is-active[data-title]");
        title.textContent = activePanel ? activePanel.dataset.title : "Add Property";
      }
      var sel = towerSelect ? towerSelect.value : "";
      if (newTowerFields) newTowerFields.style.display = sel === "__new__" ? "grid" : "none";
    }

    function validateStep1() {
      var towerId = towerSelect ? towerSelect.value : "";
      if (!towerId) {
        alert("Please select a tower or choose \"+ Add new tower\".");
        return false;
      }
      if (towerId === "__new__") {
        var name = form.querySelector("[name=tower_name]") && form.querySelector("[name=tower_name]").value.trim();
        var floors = form.querySelector("[name=number_floors]") && form.querySelector("[name=number_floors]").value;
        if (!name || !floors) {
          alert("For a new tower, please enter Tower name and Number of floors.");
          return false;
        }
      }
      return true;
    }

    function loadTowers() {
      return fetch(API + "/towers")
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          towers = data;
          if (!towerSelect) return;
          towerSelect.innerHTML = "<option value=\"\">— Select tower —</option><option value=\"__new__\">+ Add new tower</option>";
          towers.forEach(function (t) {
            var opt = document.createElement("option");
            opt.value = t.tower_id;
            opt.textContent = t.tower_name + " (" + t.number_floors + " floors)";
            towerSelect.appendChild(opt);
          });
          if (newTowerFields) newTowerFields.style.display = towerSelect.value === "__new__" ? "grid" : "none";
        })
        .catch(function () { towers = []; });
    }

    function loadProperties() {
      return fetch(API + "/properties")
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          properties = data;
          renderProperties();
        })
        .catch(function () {
          properties = [];
          renderProperties();
        });
    }

    function getFirstImageUrl(unit) {
      var raw = unit.image_urls;
      if (!raw) return null;
      try {
        var arr = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(arr) && arr.length) {
          var first = arr[0];
          return first && (typeof first === "string" ? first : first.url || first.src) ? first : null;
        }
      } catch (e) {}
      return null;
    }

    function renderProperties() {
      if (!propertiesList) return;
      propertiesList.innerHTML = "";
      if (!properties.length) {
        propertiesList.innerHTML = "<div class=\"empty-state\">No units yet. Add a property (tower + unit) above.</div>";
        return;
      }
      properties.forEach(function (unit) {
        var card = document.createElement("button");
        card.type = "button";
        card.className = "property-card property-card--clickable property-card--employee-style";
        card.dataset.unitId = unit.unit_id;
        var imgSrc = getFirstImageUrl(unit);
        var mediaHtml = "<div class=\"property-card__media\">";
        if (imgSrc) mediaHtml += "<img src=\"" + escapeHtml(imgSrc) + "\" alt=\"\" />";
        else mediaHtml += "<span class=\"property-card__placeholder\"></span>";
        mediaHtml += "</div>";
        var meta = [unit.unit_type, unit.unit_size ? unit.unit_size + " sqm" : ""].filter(Boolean).join(" · ") || "—";
        var priceLine = unit.price != null && unit.price !== "" ? " ₱ " + escapeHtml(String(unit.price)) : "";
        card.innerHTML =
          mediaHtml +
          "<div class=\"property-card__body\">" +
            "<h4 class=\"property-card__name\">" + escapeHtml(unit.unit_number || String(unit.unit_id)) + "</h4>" +
            "<p class=\"property-card__role\">" + escapeHtml(unit.tower_name || "—") + "</p>" +
            "<div class=\"property-card__meta\">" +
              "<span>" + escapeHtml(meta) + priceLine + "</span>" +
              "<span class=\"property-card__edit-label\">Edit details</span>" +
            "</div>" +
          "</div>";
        propertiesList.appendChild(card);
      });
    }

    function escapeHtml(s) {
      var div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function openModal() {
      overlay.classList.add("is-open");
      loadTowers().then(function () { setStep(1); });
    }

    function closeModal() {
      overlay.classList.remove("is-open");
      if (form) form.reset();
      selectedTowerIdOrNew = null;
      unitImageDataUrls = [null, null, null, null];
      var slots = form && form.querySelectorAll("[data-photo-slot]");
      if (slots) for (var s = 0; s < slots.length; s++) {
        var img = slots[s].querySelector(".photo-slot-preview");
        if (img) { img.removeAttribute("src"); img.hidden = true; }
        var txt = slots[s].querySelector(".photo-slot-text");
        if (txt) txt.style.display = "";
      }
    }

    function submitProperty() {
      var towerId = selectedTowerIdOrNew;
      if (towerId === undefined || towerId === null) {
        towerId = towerSelect ? towerSelect.value : "";
      }
      if (!towerId) {
        alert("Please go back and select a tower or add a new one.");
        return;
      }
      var payload = {
        unit_number: form.querySelector("[name=unit_number]") && form.querySelector("[name=unit_number]").value.trim(),
        floor_number: (form.querySelector("[name=floor_number]") && form.querySelector("[name=floor_number]").value.trim()) || null,
        unit_type: (form.querySelector("[name=unit_type]") && form.querySelector("[name=unit_type]").value) || null,
        unit_size: (form.querySelector("[name=unit_size]") && form.querySelector("[name=unit_size]").value) || null,
        description: (form.querySelector("[name=description]") && form.querySelector("[name=description]").value.trim()) || null,
      };
      if (unitImageDataUrls[0] || unitImageDataUrls[1] || unitImageDataUrls[2] || unitImageDataUrls[3]) {
        payload.image_urls = JSON.stringify([
          unitImageDataUrls[0] || "",
          unitImageDataUrls[1] || "",
          unitImageDataUrls[2] || "",
          unitImageDataUrls[3] || "",
        ]);
      }
      if (!payload.unit_number) {
        alert("Unit number is required.");
        return;
      }
      var promise = Promise.resolve(null);
      if (towerId === "__new__") {
        var name = form.querySelector("[name=tower_name]") && form.querySelector("[name=tower_name]").value.trim();
        var floors = form.querySelector("[name=number_floors]") && form.querySelector("[name=number_floors]").value;
        if (!name || !floors) {
          alert("Tower name and number of floors are required for a new tower.");
          return;
        }
        promise = fetch(API + "/towers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tower_name: name, number_floors: Number(floors) }),
        })
          .then(function (r) {
            if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed to create tower"); });
            return r.json();
          })
          .then(function (data) {
            var tid = data.tower_id;
            if (tid == null) throw new Error("Tower was not created. Check the server.");
            return tid;
          });
      } else {
        promise = Promise.resolve(Number(towerId));
      }
      promise
        .then(function (tid) {
          payload.tower_id = tid;
          return fetch(API + "/units", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
        })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed"); });
          return r.json();
        })
        .then(function () {
          closeModal();
          selectedTowerIdOrNew = null;
          loadProperties();
        })
        .catch(function (err) {
          alert(err.message || "Failed to add property.");
        });
    }

    function openUpdateModal(unit) {
      activeUnit = unit;
      if (updateSidebar) {
        updateSidebar.classList.add("is-open");
        updateSidebar.setAttribute("aria-hidden", "false");
        if (updateContent) requestAnimationFrame(function () { updateContent.classList.add("is-visible"); });
      }
      if (updateTitle) updateTitle.textContent = "Edit Unit " + (unit.unit_number || unit.unit_id);
      if (updateForm) {
        var num = updateForm.querySelector("[data-update-unit-number]");
        var floor = updateForm.querySelector("[data-update-floor]");
        var type = updateForm.querySelector("[data-update-unit-type]");
        var size = updateForm.querySelector("[data-update-unit-size]");
        var price = updateForm.querySelector("[data-update-price]");
        var desc = updateForm.querySelector("[data-update-description]");
        if (num) num.value = unit.unit_number || "";
        if (floor) floor.value = unit.floor_number || "";
        if (type) type.value = unit.unit_type || "";
        if (size) size.value = unit.unit_size != null ? unit.unit_size : "";
        if (price) price.value = unit.price != null && unit.price !== "" ? unit.price : "";
        if (desc) desc.value = unit.description || "";
      }
      updateImageDataUrls = [null, null, null, null];
      try {
        var raw = unit.image_urls;
        if (raw) {
          var arr = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (Array.isArray(arr)) for (var i = 0; i < 4 && i < arr.length; i++) if (arr[i]) updateImageDataUrls[i] = typeof arr[i] === "string" ? arr[i] : (arr[i].url || arr[i].src);
        }
      } catch (e) {}
      var grid = updateSidebar && updateSidebar.querySelector("[data-update-photo-grid]");
      if (grid) {
        var slots = grid.querySelectorAll("[data-update-photo-slot]");
        for (var j = 0; j < slots.length && j < 4; j++) {
          var preview = slots[j].querySelector(".photo-slot-preview");
          var text = slots[j].querySelector(".photo-slot-text");
          if (updateImageDataUrls[j]) {
            if (preview) { preview.src = updateImageDataUrls[j]; preview.hidden = false; }
            if (text) text.style.display = "none";
          } else {
            if (preview) { preview.removeAttribute("src"); preview.hidden = true; }
            if (text) text.style.display = "";
          }
        }
      }
      var link = buildBookingLink(unit);
      if (bookingLinkInput) bookingLinkInput.value = link;
    }

    function closeUpdateModal() {
      if (updateContent) updateContent.classList.remove("is-visible");
      setTimeout(function () {
        if (updateSidebar) {
          updateSidebar.classList.remove("is-open");
          updateSidebar.setAttribute("aria-hidden", "true");
        }
        activeUnit = null;
      }, 300);
    }

    function saveUnitUpdate() {
      if (!activeUnit || !updateForm) return;
      var numEl = updateForm.querySelector("[data-update-unit-number]");
      var unit_number = numEl ? numEl.value.trim() : "";
      if (!unit_number) { alert("Unit number is required."); return; }
      var payload = {
        unit_number: unit_number,
        floor_number: (updateForm.querySelector("[data-update-floor]") && updateForm.querySelector("[data-update-floor]").value.trim()) || null,
        unit_type: (updateForm.querySelector("[data-update-unit-type]") && updateForm.querySelector("[data-update-unit-type]").value) || null,
        unit_size: (updateForm.querySelector("[data-update-unit-size]") && updateForm.querySelector("[data-update-unit-size]").value) || null,
        description: (updateForm.querySelector("[data-update-description]") && updateForm.querySelector("[data-update-description]").value.trim()) || null,
        price: (updateForm.querySelector("[data-update-price]") && updateForm.querySelector("[data-update-price]").value) || null,
      };
      if (updateImageDataUrls[0] || updateImageDataUrls[1] || updateImageDataUrls[2] || updateImageDataUrls[3]) {
        payload.image_urls = JSON.stringify([
          updateImageDataUrls[0] || "",
          updateImageDataUrls[1] || "",
          updateImageDataUrls[2] || "",
          updateImageDataUrls[3] || "",
        ]);
      }
      fetch(API + "/units/" + activeUnit.unit_id, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed to update"); });
          return r.json();
        })
        .then(function () {
          closeUpdateModal();
          loadProperties();
        })
        .catch(function (err) {
          alert(err.message || "Failed to update unit.");
        });
    }

    function deleteUnit() {
      if (!activeUnit) return;
      if (!confirm("Delete this unit? This cannot be undone.")) return;
      fetch(API + "/units/" + activeUnit.unit_id, { method: "DELETE" })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed to delete"); });
          return r.json();
        })
        .then(function () {
          closeUpdateModal();
          loadProperties();
        })
        .catch(function (err) {
          alert(err.message || "Failed to delete unit.");
        });
    }

    if (towerSelect) {
      towerSelect.addEventListener("change", function () {
        if (newTowerFields) newTowerFields.style.display = towerSelect.value === "__new__" ? "grid" : "none";
      });
    }

    (function setupPhotoSlots() {
      if (!form) return;
      var slots = form.querySelectorAll("[data-photo-slot]");
      var inputs = form.querySelectorAll("[data-photo-input]");
      for (var i = 0; i < slots.length && i < inputs.length; i++) {
        (function (idx) {
          var slot = slots[idx];
          var input = inputs[idx];
          if (!slot || !input) return;
          slot.addEventListener("click", function () { input.click(); });
          input.addEventListener("change", function () {
            var file = input.files && input.files[0];
            if (!file || !file.type.match(/^image\//)) return;
            var reader = new FileReader();
            reader.onload = function () {
              unitImageDataUrls[idx] = reader.result;
              var preview = slot.querySelector(".photo-slot-preview");
              var text = slot.querySelector(".photo-slot-text");
              if (preview) { preview.src = reader.result; preview.hidden = false; }
              if (text) text.style.display = "none";
            };
            reader.readAsDataURL(file);
            input.value = "";
          });
        })(i);
      }
    })();

    if (openBtn) openBtn.addEventListener("click", openModal);
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    if (overlay) overlay.addEventListener("click", function (e) { if (e.target === overlay) closeModal(); });

    if (nextBtn) {
      nextBtn.addEventListener("click", function () {
        if (currentStep === 1) {
          if (!validateStep1()) return;
          selectedTowerIdOrNew = towerSelect ? towerSelect.value : "";
          setStep(2);
        } else if (currentStep === 2) {
          setStep(3);
        } else if (currentStep === 3) {
          submitProperty();
        }
      });
    }
    if (prevBtn) prevBtn.addEventListener("click", function () {
      setStep(currentStep - 1);
    });

    if (propertiesList) {
      propertiesList.addEventListener("click", function (e) {
        var card = e.target.closest("[data-unit-id]");
        if (!card) return;
        var unit = properties.find(function (u) { return String(u.unit_id) === card.dataset.unitId; });
        if (unit) openPropertyOverview(unit);
      });
    }

    function openPropertyOverview(unit) {
      activeUnit = unit;
      if (!propertyOverviewSidebar || !propertyOverviewContent) return;
      if (propertyOverviewName) propertyOverviewName.textContent = unit.unit_number || String(unit.unit_id);
      if (propertyOverviewTower) propertyOverviewTower.textContent = unit.tower_name || "—";
      var metaParts = [unit.unit_type, unit.unit_size ? unit.unit_size + " sqm" : ""].filter(Boolean);
      if (unit.price != null && unit.price !== "") metaParts.push("₱ " + unit.price);
      if (propertyOverviewMeta) propertyOverviewMeta.textContent = metaParts.length ? metaParts.join(" · ") : "—";
      var imgSrc = getFirstImageUrl(unit);
      var avatarWrap = propertyOverviewImg && propertyOverviewImg.closest(".assign-sidebar__avatar-wrap");
      if (propertyOverviewImg) {
        if (imgSrc) {
          propertyOverviewImg.src = imgSrc;
          propertyOverviewImg.style.display = "";
          if (avatarWrap) avatarWrap.classList.remove("has-placeholder");
        } else {
          propertyOverviewImg.removeAttribute("src");
          propertyOverviewImg.style.display = "none";
          if (avatarWrap) avatarWrap.classList.add("has-placeholder");
        }
      }
      propertyOverviewSidebar.classList.add("is-open");
      propertyOverviewSidebar.setAttribute("aria-hidden", "false");
      requestAnimationFrame(function () { if (propertyOverviewContent) propertyOverviewContent.classList.add("is-visible"); });
    }

    function closePropertyOverview() {
      if (propertyOverviewContent) propertyOverviewContent.classList.remove("is-visible");
      setTimeout(function () {
        if (propertyOverviewSidebar) {
          propertyOverviewSidebar.classList.remove("is-open");
          propertyOverviewSidebar.setAttribute("aria-hidden", "true");
        }
      }, 300);
    }

    var closeOverviewBtns = document.querySelectorAll("[data-close-property-overview]");
    closeOverviewBtns.forEach(function (btn) { btn.addEventListener("click", closePropertyOverview); });
    if (propertyOverviewSidebar && propertyOverviewSidebar.querySelector(".assign-sidebar__backdrop")) {
      propertyOverviewSidebar.querySelector(".assign-sidebar__backdrop").addEventListener("click", closePropertyOverview);
    }
    if (propertyEditDetailsBtn) {
      propertyEditDetailsBtn.addEventListener("click", function () {
        closePropertyOverview();
        setTimeout(function () {
          if (activeUnit) openUpdateModal(activeUnit);
        }, 320);
      });
    }
    if (propertyDeleteUnitBtn) {
      propertyDeleteUnitBtn.addEventListener("click", function () {
        if (!activeUnit) return;
        if (!confirm("Delete unit " + (activeUnit.unit_number || activeUnit.unit_id) + "? This cannot be undone.")) return;
        fetch(API + "/units/" + activeUnit.unit_id, { method: "DELETE" })
          .then(function (r) {
            if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed to delete"); });
            closePropertyOverview();
            loadProperties();
          })
          .catch(function (err) { alert(err.message || "Failed to delete unit."); });
      });
    }

    updateCloseBtns.forEach(function (btn) { btn.addEventListener("click", closeUpdateModal); });
    if (updateSidebar && updateSidebar.querySelector(".assign-sidebar__backdrop")) {
      updateSidebar.querySelector(".assign-sidebar__backdrop").addEventListener("click", closeUpdateModal);
    }
    if (updateSidebar && updateSidebar.classList.contains("modal-overlay")) {
      updateSidebar.addEventListener("click", function (e) {
        if (e.target === updateSidebar) closeUpdateModal();
      });
    }
    if (saveUpdateBtn) saveUpdateBtn.addEventListener("click", saveUnitUpdate);
    if (deleteUnitBtn) deleteUnitBtn.addEventListener("click", deleteUnit);
    (function setupUpdatePhotoSlots() {
      if (!updateSidebar) return;
      var grid = updateSidebar.querySelector("[data-update-photo-grid]");
      var inputs = updateSidebar.querySelectorAll("[data-update-photo-input]");
      if (!grid || !inputs.length) return;
      var slots = grid.querySelectorAll("[data-update-photo-slot]");
      for (var i = 0; i < slots.length && i < inputs.length; i++) {
        (function (idx) {
          var slot = slots[idx];
          var input = inputs[idx];
          if (!slot || !input) return;
          slot.addEventListener("click", function () { input.click(); });
          input.addEventListener("change", function () {
            var file = input.files && input.files[0];
            if (!file || !file.type.match(/^image\//)) return;
            var reader = new FileReader();
            reader.onload = function () {
              updateImageDataUrls[idx] = reader.result;
              var preview = slot.querySelector(".photo-slot-preview");
              var text = slot.querySelector(".photo-slot-text");
              if (preview) { preview.src = reader.result; preview.hidden = false; }
              if (text) text.style.display = "none";
            };
            reader.readAsDataURL(file);
            input.value = "";
          });
        })(i);
      }
    })();
    if (openLinkBtn) openLinkBtn.addEventListener("click", function () {
      if (bookingLinkInput && bookingLinkInput.value) window.open(bookingLinkInput.value, "_blank");
    });
    if (copyBtn) copyBtn.addEventListener("click", function () {
      if (!bookingLinkInput) return;
      navigator.clipboard.writeText(bookingLinkInput.value).catch(function () { bookingLinkInput.select(); });
    });

    loadProperties();
  }

  function initEmployees() {
    var employeesGrid = document.querySelector("[data-employees]");
    var addEmployeeBtn = document.querySelector("[data-add-employee]");
    var employeeModal = document.querySelector("[data-employee-modal]");
    var employeeModalClose = document.querySelector("[data-close-employee-modal]");
    var employeeForm = document.querySelector("[data-employee-form]");
    var assignSidebar = document.getElementById("assignSidebar");
    var assignContent = document.getElementById("assignSidebarContent");
    var assignModalImg = document.getElementById("assignModalImg");
    var assignModalName = document.getElementById("assignModalName");
    var assignModalRole = document.getElementById("assignModalRole");
    var assignModalID = document.getElementById("assignModalID");
    var assignTowersContainer = document.querySelector("[data-assign-towers]");
    var saveAssignmentBtn = document.querySelector("[data-save-assignment]");
    var closeAssignButtons = document.querySelectorAll("[data-close-assign]");
    var editEmployeeModal = document.querySelector("[data-edit-employee-modal]");
    var editEmployeeForm = document.querySelector("[data-edit-employee-form]");
    var closeEditEmployeeBtn = document.querySelector("[data-close-edit-employee]");
    var saveEditEmployeeBtn = document.querySelector("[data-save-edit-employee]");
    var deleteEmployeeBtn = document.querySelector("[data-delete-employee]");
    var editEmployeeBtn = document.querySelector("[data-edit-employee-btn]");
    var deleteEmployeeSidebarBtn = document.querySelector("[data-delete-employee-btn]");

    var employees = [];
    var towers = [];
    var activeEmployeeId = null;

    function getAuthHeaders(withJson) {
      var h = {};
      if (withJson) h["Content-Type"] = "application/json";
      try {
        var t = localStorage && localStorage.getItem("token");
        if (t) h.Authorization = "Bearer " + t;
      } catch (e) {}
      return h;
    }

    function loadEmployees() {
      return fetch(API + "/employees", { headers: getAuthHeaders() })
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          employees = data;
          renderEmployees();
        })
        .catch(function () {
          employees = [];
          renderEmployees();
        });
    }

    function renderEmployees() {
      if (!employeesGrid) return;
      employeesGrid.innerHTML = "";
      if (!employees.length) {
        employeesGrid.innerHTML = "<div class=\"empty-state\">No employees yet. Use Add Employee to create an account.</div>";
        return;
      }
      employees.forEach(function (emp) {
        var card = document.createElement("button");
        card.type = "button";
        card.className = "employee-card";
        card.dataset.employeeId = emp.employee_id;
        card.dataset.name = emp.full_name || "";
        card.dataset.role = emp.role_type || "—";
        card.dataset.id = "REG-" + String(emp.employee_id).padStart(6, "0");
        card.dataset.assignment = emp.assigned_tower || "";
        var badgeClass = emp.assigned_tower ? "employee-card__badge--active" : "employee-card__badge--unassigned";
        var badgeText = emp.assigned_tower ? "Active" : "Unassigned";
        var locationHtml = emp.assigned_tower
          ? "<span class=\"employee-card__location\"><span class=\"icon icon--sm\"><svg viewBox=\"0 0 24 24\"><path d=\"M3 21h18\"></path><path d=\"M5 21V7l7-4 7 4v14\"></path><path d=\"M9 21v-6h6v6\"></path></svg></span> " + escapeHtml(emp.assigned_tower) + "</span>"
          : "<span class=\"employee-card__location employee-card__location--none\">Not assigned</span>";
        var imgUrl = "https://api.dicebear.com/7.x/avataaars/svg?seed=" + encodeURIComponent(emp.full_name || emp.employee_id);
        card.innerHTML =
          "<div class=\"employee-card__media\">" +
            "<img src=\"" + imgUrl + "\" alt=\"" + escapeHtml(emp.full_name || "") + "\" />" +
            "<span class=\"employee-card__badge " + badgeClass + "\">" + badgeText + "</span>" +
          "</div>" +
          "<div class=\"employee-card__body\">" +
            "<h4 class=\"employee-card__name\">" + escapeHtml(emp.full_name || "—") + "</h4>" +
            "<p class=\"employee-card__role\">" + escapeHtml(emp.role_type || "—") + "</p>" +
            "<div class=\"employee-card__meta\">" +
              "<span>ID: REG-" + String(emp.employee_id).padStart(6, "0") + "</span>" +
              locationHtml +
            "</div>" +
          "</div>";
        employeesGrid.appendChild(card);
      });
    }

    function escapeHtml(s) {
      var div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function openAddEmployeeModal() {
      if (employeeModal) employeeModal.classList.add("is-open");
      if (employeeForm) employeeForm.reset();
    }

    function closeAddEmployeeModal() {
      if (employeeModal) employeeModal.classList.remove("is-open");
    }

    function submitEmployee() {
      if (!employeeForm) return;
      var full_name = employeeForm.querySelector("[name=full_name]") && employeeForm.querySelector("[name=full_name]").value.trim();
      var username = employeeForm.querySelector("[name=username]") && employeeForm.querySelector("[name=username]").value.trim();
      var password = employeeForm.querySelector("[name=password]") && employeeForm.querySelector("[name=password]").value;
      var email = employeeForm.querySelector("[name=email]") && employeeForm.querySelector("[name=email]").value.trim();
      var contact_number = employeeForm.querySelector("[name=contact_number]") && employeeForm.querySelector("[name=contact_number]").value.trim() || null;
      var address = employeeForm.querySelector("[name=address]") && employeeForm.querySelector("[name=address]").value.trim() || null;
      var role_type = employeeForm.querySelector("[name=role_type]") && employeeForm.querySelector("[name=role_type]").value || "Front Desk";
      if (!full_name || !username || !password || !email) {
        alert("Full name, username, password, and email are required.");
        return;
      }
      fetch(API + "/employees", {
        method: "POST",
        headers: getAuthHeaders(true),
        body: JSON.stringify({
          full_name: full_name,
          username: username,
          password: password,
          email: email,
          contact_number: contact_number,
          address: address,
          role_type: role_type,
        }),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed"); });
          return r.json();
        })
        .then(function () {
          closeAddEmployeeModal();
          loadEmployees();
        })
        .catch(function (err) {
          alert(err.message || "Failed to create employee.");
        });
    }

    function loadTowersForAssign() {
      return fetch(API + "/towers")
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          towers = data;
          if (!assignTowersContainer) return;
          assignTowersContainer.innerHTML = "";
          data.forEach(function (t, i) {
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "assign-tower" + (i === 0 ? " assign-tower--selected" : "");
            btn.dataset.towerId = t.tower_id;
            btn.dataset.towerName = t.tower_name;
            btn.innerHTML =
              "<div class=\"assign-tower__info\">" +
                "<div class=\"assign-tower__icon\">" +
                  "<svg viewBox=\"0 0 24 24\"><path d=\"M3 21h18\"></path><path d=\"M5 21V7l7-4 7 4v14\"></path><path d=\"M9 21v-6h6v6\"></path></svg>" +
                "</div>" +
                "<div>" +
                  "<p class=\"assign-tower__title\">" + escapeHtml(t.tower_name) + "</p>" +
                  "<p class=\"assign-tower__desc\">" + (t.number_floors ? t.number_floors + " floors" : "") + "</p>" +
                "</div>" +
              "</div>" +
              (i === 0 ? "<span class=\"assign-tower__check icon\"><svg viewBox=\"0 0 24 24\"><path d=\"M22 11.08V12a10 10 0 1 1-5.93-9.14\"></path><polyline points=\"22 4 12 14.01 9 11.01\"></polyline></svg></span>" : "");
            assignTowersContainer.appendChild(btn);
          });
          assignTowersContainer.querySelectorAll(".assign-tower").forEach(function (btn) {
            btn.addEventListener("click", function () {
              assignTowersContainer.querySelectorAll(".assign-tower").forEach(function (b) {
                b.classList.remove("assign-tower--selected");
                var ch = b.querySelector(".assign-tower__check");
                if (ch) b.removeChild(ch);
              });
              var check = document.createElement("span");
              check.className = "assign-tower__check icon";
              check.innerHTML = "<svg viewBox=\"0 0 24 24\"><path d=\"M22 11.08V12a10 10 0 1 1-5.93-9.14\"></path><polyline points=\"22 4 12 14.01 9 11.01\"></polyline></svg>";
              btn.classList.add("assign-tower--selected");
              btn.appendChild(check);
            });
          });
        })
        .catch(function () { towers = []; });
    }

    function openAssignModal(employeeId, name, role, id, img) {
      activeEmployeeId = employeeId;
      if (!assignSidebar || !assignContent) return;
      assignModalName.textContent = name;
      assignModalRole.textContent = role;
      assignModalID.textContent = "ID: " + id;
      assignModalImg.src = img || "https://api.dicebear.com/7.x/avataaars/svg?seed=" + encodeURIComponent(name);
      assignModalImg.alt = name;
      assignSidebar.classList.add("is-open");
      assignSidebar.setAttribute("aria-hidden", "false");
      loadTowersForAssign().then(function () {
        requestAnimationFrame(function () {
          assignContent.classList.add("is-visible");
        });
      });
    }

    function closeAssignModal() {
      if (!assignContent || !assignSidebar) return;
      assignContent.classList.remove("is-visible");
      setTimeout(function () {
        assignSidebar.classList.remove("is-open");
        assignSidebar.setAttribute("aria-hidden", "true");
        activeEmployeeId = null;
      }, 300);
    }

    function openEditEmployeeModal() {
      var emp = employees.find(function (e) { return String(e.employee_id) === String(activeEmployeeId); });
      if (!emp || !editEmployeeModal || !editEmployeeForm) return;
      var fullName = editEmployeeForm.querySelector("[data-edit-full-name]");
      var email = editEmployeeForm.querySelector("[data-edit-email]");
      var contact = editEmployeeForm.querySelector("[data-edit-contact]");
      var address = editEmployeeForm.querySelector("[data-edit-address]");
      var role = editEmployeeForm.querySelector("[data-edit-role]");
      if (fullName) fullName.value = emp.full_name || "";
      if (email) email.value = emp.email || "";
      if (contact) contact.value = emp.contact_number || "";
      if (address) address.value = emp.address || "";
      if (role) role.value = emp.role_type || "Front Desk";
      editEmployeeModal.classList.add("is-open");
    }

    function closeEditEmployeeModal() {
      if (editEmployeeModal) editEmployeeModal.classList.remove("is-open");
    }

    function saveEditEmployee() {
      if (!activeEmployeeId || !editEmployeeForm) return;
      var full_name = editEmployeeForm.querySelector("[data-edit-full-name]") && editEmployeeForm.querySelector("[data-edit-full-name]").value.trim();
      var email = editEmployeeForm.querySelector("[data-edit-email]") && editEmployeeForm.querySelector("[data-edit-email]").value.trim();
      var contact_number = editEmployeeForm.querySelector("[data-edit-contact]") && editEmployeeForm.querySelector("[data-edit-contact]").value.trim() || null;
      var address = editEmployeeForm.querySelector("[data-edit-address]") && editEmployeeForm.querySelector("[data-edit-address]").value.trim() || null;
      var role_type = editEmployeeForm.querySelector("[data-edit-role]") && editEmployeeForm.querySelector("[data-edit-role]").value || "Front Desk";
      if (!full_name || !email) { alert("Full name and email are required."); return; }
      fetch(API + "/employees/" + activeEmployeeId, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ full_name: full_name, email: email, contact_number: contact_number, address: address, role_type: role_type }),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed"); });
          return r.json();
        })
        .then(function () {
          closeEditEmployeeModal();
          closeAssignModal();
          loadEmployees();
        })
        .catch(function (err) {
          alert(err.message || "Failed to update employee.");
        });
    }

    function deleteEmployeeAction() {
      if (!activeEmployeeId) return;
      if (!confirm("Delete this employee? This cannot be undone.")) return;
      fetch(API + "/employees/" + activeEmployeeId, { method: "DELETE" })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed"); });
          return r.json();
        })
        .then(function () {
          closeEditEmployeeModal();
          closeAssignModal();
          loadEmployees();
        })
        .catch(function (err) {
          alert(err.message || "Failed to delete employee.");
        });
    }

    if (addEmployeeBtn) addEmployeeBtn.addEventListener("click", openAddEmployeeModal);
    if (employeeModalClose) employeeModalClose.addEventListener("click", closeAddEmployeeModal);
    if (employeeModal && employeeModal.querySelector(".modal-overlay")) {
      employeeModal.querySelector(".modal-overlay").addEventListener("click", function (e) {
        if (e.target === employeeModal.querySelector(".modal-overlay")) closeAddEmployeeModal();
      });
    }
    if (employeeForm) {
      var submitBtn = employeeForm.querySelector("[data-submit-employee]");
      if (submitBtn) submitBtn.addEventListener("click", submitEmployee);
    }

    if (employeesGrid) {
      employeesGrid.addEventListener("click", function (e) {
        var card = e.target.closest("[data-employee-id]");
        if (!card) return;
        openAssignModal(
          card.dataset.employeeId,
          card.dataset.name,
          card.dataset.role,
          card.dataset.id,
          card.querySelector("img") && card.querySelector("img").src
        );
      });
    }

    closeAssignButtons.forEach(function (btn) {
      btn.addEventListener("click", closeAssignModal);
    });
    if (assignSidebar && assignSidebar.querySelector(".assign-sidebar__backdrop")) {
      assignSidebar.querySelector(".assign-sidebar__backdrop").addEventListener("click", closeAssignModal);
    }

    if (editEmployeeBtn) editEmployeeBtn.addEventListener("click", function () { openEditEmployeeModal(); });
    if (deleteEmployeeSidebarBtn) deleteEmployeeSidebarBtn.addEventListener("click", deleteEmployeeAction);
    if (closeEditEmployeeBtn) closeEditEmployeeBtn.addEventListener("click", closeEditEmployeeModal);
    if (editEmployeeModal && editEmployeeModal.querySelector(".modal-overlay")) {
      editEmployeeModal.querySelector(".modal-overlay").addEventListener("click", function (e) {
        if (e.target === editEmployeeModal.querySelector(".modal-overlay")) closeEditEmployeeModal();
      });
    }
    if (saveEditEmployeeBtn) saveEditEmployeeBtn.addEventListener("click", saveEditEmployee);
    if (deleteEmployeeBtn) deleteEmployeeBtn.addEventListener("click", deleteEmployeeAction);

    if (saveAssignmentBtn) {
      saveAssignmentBtn.addEventListener("click", function () {
        var selected = assignTowersContainer && assignTowersContainer.querySelector(".assign-tower--selected");
        if (selected && activeEmployeeId) {
          var towerId = selected.dataset.towerId;
          fetch(API + "/employees/" + activeEmployeeId + "/assign-tower", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tower_id: Number(towerId) }),
          })
            .then(function (r) {
              if (r.status === 501) return r.json().then(function (e) { throw new Error(e.error); });
              if (!r.ok) throw new Error("Failed to save");
              return r.json();
            })
            .then(function () {
              loadEmployees();
              closeAssignModal();
            })
            .catch(function (err) {
              alert(err.message || "Could not save assignment.");
            });
        } else {
          closeAssignModal();
        }
      });
    }

    loadEmployees();
  }

  function initBookings() {
    var listNext7 = document.querySelector("[data-list=\"next7\"]");
    var listMonth = document.querySelector("[data-list=\"month\"]");
    var listLater = document.querySelector("[data-list=\"later\"]");
    var emptyEl = document.querySelector("[data-bookings-empty]");
    var detailSidebar = document.querySelector("[data-booking-detail-sidebar]");
    var detailContent = document.getElementById("bookingDetailSidebarContent");
    var detailTitle = document.querySelector("[data-booking-detail-title]");
    var detailBody = document.querySelector("[data-booking-detail-body]");
    var detailActions = document.querySelector("[data-booking-detail-actions]");
    var closeDetailBtns = document.querySelectorAll("[data-close-booking-detail]");
    var confirmBtn = document.querySelector("[data-confirm-booking]");
    var rejectBtn = document.querySelector("[data-reject-booking]");
    var rejectModal = document.querySelector("[data-reject-reason-modal]");
    var rejectReasonInput = document.querySelector("[data-reject-reason]");
    var closeRejectBtn = document.querySelector("[data-close-reject-modal]");
    var cancelRejectBtn = document.querySelector("[data-cancel-reject]");
    var submitRejectBtn = document.querySelector("[data-submit-reject]");

    var bookings = [];
    var activeBookingId = null;

    function escapeHtml(s) {
      if (s == null || s === undefined) return "";
      var div = document.createElement("div");
      div.textContent = s;
      return div.innerHTML;
    }

    function getInitials(name) {
      if (!name || !name.trim()) return "—";
      var parts = name.trim().split(/\s+/);
      if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      return (parts[0][0] || "?").toUpperCase();
    }

    function formatDate(d) {
      if (!d) return "—";
      try {
        var date = new Date(d);
        return isNaN(date.getTime()) ? d : date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      } catch (e) { return d; }
    }

    function getSection(checkIn) {
      if (!checkIn) return "later";
      var d = new Date(checkIn);
      if (isNaN(d.getTime())) return "later";
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var in7 = new Date(today);
      in7.setDate(in7.getDate() + 7);
      var endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
      if (d >= today && d <= in7) return "next7";
      if (d <= endOfMonth) return "month";
      return "later";
    }

    function statusClass(s) {
      if (s === "confirmed") return "booking-status--confirmed";
      if (s === "rejected") return "booking-status--rejected";
      return "booking-status--pending";
    }

    function statusLabel(s) {
      if (s === "confirmed") return "Confirmed";
      if (s === "rejected") return "Cancelled";
      return "Pending";
    }

    function loadBookings() {
      return fetch(API + "/bookings")
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (data) {
          bookings = data || [];
          renderBookings();
        })
        .catch(function () {
          bookings = [];
          renderBookings();
        });
    }

    function renderBookings() {
      var next7 = [];
      var month = [];
      var later = [];
      bookings.forEach(function (b) {
        var section = getSection(b.check_in_date);
        if (section === "next7") next7.push(b);
        else if (section === "month") month.push(b);
        else later.push(b);
      });

      function renderList(container, list) {
        if (!container) return;
        container.innerHTML = "";
        list.forEach(function (b) {
          var card = document.createElement("button");
          card.type = "button";
          card.className = "booking-card";
          card.dataset.bookingId = b.booking_id;
          var dates = (b.check_in_date && b.check_out_date)
            ? "Check-in: " + formatDate(b.check_in_date) + " - Check-out: " + formatDate(b.check_out_date)
            : (b.inclusive_dates || "—");
          var unitInfo = [b.unit_number, b.unit_type].filter(Boolean).join(" - ") || "Unit";
          card.innerHTML =
            "<div class=\"booking-card__left\">" +
              "<div class=\"booking-card__avatar\">" + getInitials(b.guest_name) + "</div>" +
              "<div class=\"booking-card__info\">" +
                "<p class=\"booking-card__name\">" + escapeHtml(b.guest_name) + " - " + escapeHtml(unitInfo) + "</p>" +
                "<p class=\"booking-card__dates\">" + escapeHtml(dates) + "</p>" +
              "</div>" +
            "</div>" +
            "<div class=\"booking-card__status " + statusClass(b.status) + "\">" +
              "<span class=\"booking-status-dot\"></span>" +
              "<span>" + statusLabel(b.status) + "</span>" +
            "</div>";
          container.appendChild(card);
        });
      }

      renderList(listNext7, next7);
      renderList(listMonth, month);
      renderList(listLater, later);

      var total = bookings.length;
      if (emptyEl) emptyEl.style.display = total ? "none" : "block";
    }

    function openDetailModal(bookingId) {
      activeBookingId = bookingId;
      fetch(API + "/bookings/" + bookingId)
        .then(function (r) {
          if (!r.ok) throw new Error("Not found");
          return r.json();
        })
        .then(function (b) {
          if (!detailTitle || !detailBody) return;
          detailTitle.textContent = "Booking – " + (b.guest_name || "Guest") + " · " + (b.unit_number || "") + (b.tower_name ? " " + b.tower_name : "");
          var unitInfo = [b.unit_number, b.unit_type, b.tower_name].filter(Boolean).join(" · ") || "—";
          var html =
            "<div class=\"booking-detail-grid\">" +
              "<div class=\"booking-detail-block\"><h4>Personal information</h4>" +
              "<p><strong>Name:</strong> " + escapeHtml(b.guest_name) + "</p>" +
              "<p><strong>Address:</strong> " + escapeHtml(b.permanent_address) + "</p>" +
              "<p><strong>Age:</strong> " + escapeHtml(b.age) + " &nbsp; <strong>Nationality:</strong> " + escapeHtml(b.nationality) + "</p>" +
              "<p><strong>Relation to owner:</strong> " + escapeHtml(b.relation_to_owner) + "</p>" +
              "<p><strong>Occupation:</strong> " + escapeHtml(b.occupation) + "</p>" +
              "<p><strong>Email:</strong> " + escapeHtml(b.email) + "</p>" +
              "<p><strong>Contact:</strong> " + escapeHtml(b.contact_number) + "</p>" +
              "</div>" +
              "<div class=\"booking-detail-block\"><h4>Unit &amp; stay</h4>" +
              "<p><strong>Unit:</strong> " + escapeHtml(unitInfo) + "</p>" +
              "<p><strong>Owner name:</strong> " + escapeHtml(b.owner_name) + "</p>" +
              "<p><strong>Owner contact:</strong> " + escapeHtml(b.owner_contact) + "</p>" +
              "<p><strong>Inclusive dates:</strong> " + escapeHtml(b.inclusive_dates) + "</p>" +
              "<p><strong>Check-in:</strong> " + formatDate(b.check_in_date) + " &nbsp; <strong>Check-out:</strong> " + formatDate(b.check_out_date) + "</p>" +
              "<p><strong>Purpose of stay:</strong> " + escapeHtml(b.purpose_of_stay) + "</p>" +
              "<p><strong>Paid:</strong> " + escapeHtml(b.paid_yes_no) + (b.amount_paid ? " – " + escapeHtml(b.amount_paid) : "") + "</p>" +
              "<p><strong>Booking platform:</strong> " + escapeHtml(b.booking_platform) + "</p>" +
              (function () {
                if (b.payment_method === "upload" && b.payment_proof) {
                  return "<p><strong>Payment method:</strong> Online</p><img src=\"" + escapeHtml(b.payment_proof) + "\" alt=\"Payment proof\" class=\"booking-payment-proof-img\" />";
                }
                return "<p><strong>Payment method:</strong> " + escapeHtml(b.payment_method === "cash" || !b.payment_method ? "Cash" : b.payment_method) + "</p>";
              })() +
              "</div>" +
              "<div class=\"booking-detail-block booking-detail-block--status\"><h4>Status</h4>" +
              "<p><strong>" + statusLabel(b.status) + "</strong></p>" +
              (b.rejection_reason ? "<p class=\"booking-rejection-reason\"><strong>Rejection reason:</strong> " + escapeHtml(b.rejection_reason) + "</p>" : "") +
              "</div>" +
              "</div>";
          if (b.signature_data) {
            html += "<div class=\"booking-detail-block booking-detail-block--signature\"><h4>Signature</h4><img src=\"" + escapeHtml(b.signature_data) + "\" alt=\"Signature\" class=\"booking-signature-img\" /></div>";
          }
          detailBody.innerHTML = html;
          if (detailActions) detailActions.style.display = b.status === "pending" ? "flex" : "none";
          if (detailSidebar) {
            detailSidebar.classList.add("is-open");
            detailSidebar.setAttribute("aria-hidden", "false");
            if (detailContent) requestAnimationFrame(function () { detailContent.classList.add("is-visible"); });
          }
        })
        .catch(function () {
          alert("Could not load booking details.");
        });
    }

    function closeDetailModal() {
      if (detailContent) detailContent.classList.remove("is-visible");
      // Move focus out before aria-hidden so assistive tech doesn't get blocked
      if (detailSidebar && detailSidebar.contains(document.activeElement)) {
        document.body.setAttribute("tabindex", "-1");
        document.body.focus();
      }
      setTimeout(function () {
        if (detailSidebar) {
          detailSidebar.classList.remove("is-open");
          detailSidebar.setAttribute("aria-hidden", "true");
        }
        activeBookingId = null;
      }, 300);
    }

    function confirmBooking() {
      if (!activeBookingId) return;
      fetch(API + "/bookings/" + activeBookingId + "/confirm", { method: "PUT" })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed"); });
          return r.json();
        })
        .then(function (data) {
          closeDetailModal();
          loadBookings();
          if (data.emailSent) {
            alert("Booking confirmed. Confirmation email with QR code sent to the guest.");
          } else if (data.emailError) {
            alert("Booking confirmed, but no email was sent: " + data.emailError);
          } else {
            alert("Booking confirmed.");
          }
        })
        .catch(function (err) {
          alert(err.message || "Failed to confirm.");
        });
    }

    function openRejectModal() {
      if (rejectReasonInput) rejectReasonInput.value = "";
      if (rejectModal) rejectModal.classList.add("is-open");
    }

    function closeRejectModal() {
      if (rejectModal) rejectModal.classList.remove("is-open");
    }

    function submitReject() {
      var reason = rejectReasonInput && rejectReasonInput.value.trim();
      if (!reason) {
        alert("Please provide a reason for rejection.");
        return;
      }
      if (!activeBookingId) return;
      fetch(API + "/bookings/" + activeBookingId + "/reject", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason }),
      })
        .then(function (r) {
          if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || "Failed"); });
          return r.json();
        })
        .then(function () {
          closeRejectModal();
          closeDetailModal();
          loadBookings();
        })
        .catch(function (err) {
          alert(err.message || "Failed to reject.");
        });
    }

    if (listNext7 && listMonth && listLater) {
      var lists = document.querySelectorAll(".bookings-list");
      lists.forEach(function (list) {
        list.addEventListener("click", function (e) {
          var card = e.target.closest("[data-booking-id]");
          if (card) openDetailModal(card.dataset.bookingId);
        });
      });
    }
    closeDetailBtns.forEach(function (btn) { btn.addEventListener("click", closeDetailModal); });
    if (detailSidebar && detailSidebar.querySelector(".assign-sidebar__backdrop")) {
      detailSidebar.querySelector(".assign-sidebar__backdrop").addEventListener("click", closeDetailModal);
    }
    if (confirmBtn) confirmBtn.addEventListener("click", confirmBooking);
    if (rejectBtn) rejectBtn.addEventListener("click", openRejectModal);
    if (closeRejectBtn) closeRejectBtn.addEventListener("click", closeRejectModal);
    if (cancelRejectBtn) cancelRejectBtn.addEventListener("click", closeRejectModal);
    if (rejectModal && rejectModal.querySelector(".modal-overlay")) {
      rejectModal.addEventListener("click", function (e) { if (e.target === rejectModal) closeRejectModal(); });
    }
    if (submitRejectBtn) submitRejectBtn.addEventListener("click", submitReject);

    loadBookings();
  }
})();
