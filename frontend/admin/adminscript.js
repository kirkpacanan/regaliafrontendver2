(function () {
  "use strict";

  var API = "/api";
  var page = document.body.getAttribute("data-page");

  if (page === "properties") {
    initProperties();
  } else if (page === "employees") {
    initEmployees();
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
    var updateModal = document.querySelector("[data-update-modal]");
    var updateCloseBtn = document.querySelector("[data-close-update]");
    var updateTitle = document.querySelector("[data-update-title]");
    var bookingLinkInput = document.querySelector("[data-booking-link]");
    var saveUpdateBtn = document.querySelector("[data-save-update]");
    var copyBtn = document.querySelector("[data-copy-link]");
    var openLinkBtn = document.querySelector("[data-open-link]");
    var updateForm = document.querySelector("[data-update-form]");
    var deleteUnitBtn = document.querySelector("[data-delete-unit]");

    var properties = [];
    var towers = [];
    var currentStep = 1;
    var activeUnit = null;
    var selectedTowerIdOrNew = null; // "__new__" or number; set when leaving step 1
    var unitImageDataUrls = [null, null, null, null]; // base64 data URLs for 4 slots
    var updateImageDataUrls = [null, null, null, null]; // for edit modal

    function buildBookingLink(unit) {
      var base = window.location.origin + (window.location.pathname.indexOf("/admin") !== -1 ? "/admin" : "") + "/../guest/booking.html";
      var params = new URLSearchParams({
        unit: unit.unit_number || unit.unit_id,
        tower: unit.tower_name || "",
        unit_type: unit.unit_type || "",
      });
      return base.replace("/admin/../", "/") + "?" + params.toString();
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
        card.className = "property-card property-card--clickable";
        card.dataset.unitId = unit.unit_id;
        var imgSrc = getFirstImageUrl(unit);
        var mediaHtml = "<div class=\"property-card__media\">";
        if (imgSrc) mediaHtml += "<img src=\"" + escapeHtml(imgSrc) + "\" alt=\"\" />";
        else mediaHtml += "<span class=\"property-card__placeholder\"></span>";
        mediaHtml += "</div>";
        var meta = [unit.unit_type, unit.unit_size ? unit.unit_size + " sqm" : ""].filter(Boolean).join(" · ") || "—";
        var priceLine = unit.price != null && unit.price !== "" ? "<div class=\"property-card__meta\">₱ " + escapeHtml(String(unit.price)) + "</div>" : "";
        card.innerHTML =
          mediaHtml +
          "<div class=\"property-card__body\">" +
            "<h4 class=\"property-card__title\">" + escapeHtml(unit.unit_number || String(unit.unit_id)) + "</h4>" +
            "<p class=\"property-card__meta\">" + escapeHtml(unit.tower_name || "—") + "</p>" +
            "<div class=\"property-card__meta\">" + escapeHtml(meta) + "</div>" +
            priceLine +
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
      if (updateModal) updateModal.classList.add("is-open");
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
      var grid = updateModal && updateModal.querySelector("[data-update-photo-grid]");
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
      if (updateModal) updateModal.classList.remove("is-open");
      activeUnit = null;
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
        if (unit) openUpdateModal(unit);
      });
    }

    if (updateCloseBtn) updateCloseBtn.addEventListener("click", closeUpdateModal);
    if (updateModal) updateModal.addEventListener("click", function (e) { if (e.target === updateModal) closeUpdateModal(); });
    if (saveUpdateBtn) saveUpdateBtn.addEventListener("click", saveUnitUpdate);
    if (deleteUnitBtn) deleteUnitBtn.addEventListener("click", deleteUnit);
    (function setupUpdatePhotoSlots() {
      if (!updateModal) return;
      var grid = updateModal.querySelector("[data-update-photo-grid]");
      var inputs = updateModal.querySelectorAll("[data-update-photo-input]");
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

    function loadEmployees() {
      return fetch(API + "/employees")
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
        headers: { "Content-Type": "application/json" },
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
})();
