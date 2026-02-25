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
    var unitInfo = document.querySelector("[data-unit-info]");
    var bookingLinkInput = document.querySelector("[data-booking-link]");
    var saveUpdateBtn = document.querySelector("[data-save-update]");
    var copyBtn = document.querySelector("[data-copy-link]");
    var openLinkBtn = document.querySelector("[data-open-link]");

    var properties = [];
    var towers = [];
    var currentStep = 1;
    var activeUnit = null;
    var selectedTowerIdOrNew = null; // "__new__" or number; set when leaving step 1

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
        var meta = [unit.unit_type, unit.unit_size ? unit.unit_size + " sqm" : ""].filter(Boolean).join(" · ") || "—";
        card.innerHTML =
          "<div class=\"property-card__media\"><span class=\"property-card__placeholder\"></span></div>" +
          "<div class=\"property-card__title\">" + (unit.unit_number || unit.unit_id) + "</div>" +
          "<div class=\"property-card__meta\">" + (unit.tower_name || "—") + "</div>" +
          "<div class=\"property-card__meta\">" + meta + "</div>";
        propertiesList.appendChild(card);
      });
    }

    function openModal() {
      overlay.classList.add("is-open");
      loadTowers().then(function () { setStep(1); });
    }

    function closeModal() {
      overlay.classList.remove("is-open");
      if (form) form.reset();
      selectedTowerIdOrNew = null;
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
      var img1 = form.querySelector("[name=image1]") && form.querySelector("[name=image1]").value.trim();
      var img2 = form.querySelector("[name=image2]") && form.querySelector("[name=image2]").value.trim();
      var img3 = form.querySelector("[name=image3]") && form.querySelector("[name=image3]").value.trim();
      var img4 = form.querySelector("[name=image4]") && form.querySelector("[name=image4]").value.trim();
      if (img1 || img2 || img3 || img4) {
        payload.image_urls = JSON.stringify([img1 || "", img2 || "", img3 || "", img4 || ""].filter(Boolean));
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
      if (updateTitle) updateTitle.textContent = "Unit " + (unit.unit_number || unit.unit_id);
      if (unitInfo) unitInfo.textContent = (unit.tower_name || "—") + " · Unit " + (unit.unit_number || "—") + (unit.unit_type ? " · " + unit.unit_type : "");
      var link = buildBookingLink(unit);
      if (bookingLinkInput) bookingLinkInput.value = link;
    }

    function closeUpdateModal() {
      if (updateModal) updateModal.classList.remove("is-open");
      activeUnit = null;
    }

    if (towerSelect) {
      towerSelect.addEventListener("change", function () {
        if (newTowerFields) newTowerFields.style.display = towerSelect.value === "__new__" ? "grid" : "none";
      });
    }

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
    if (saveUpdateBtn) saveUpdateBtn.addEventListener("click", closeUpdateModal);
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
