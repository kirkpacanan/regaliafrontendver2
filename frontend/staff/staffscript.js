(function () {
  "use strict";
  var loc = typeof window !== "undefined" && window.location ? window.location : {};
  var origin = loc.origin || "";
  var protocol = String(loc.protocol || "").toLowerCase();
  var isFile = !origin || origin === "null" || protocol === "file:";
  var API = typeof window.REGALIA_API_URL !== "undefined" ? window.REGALIA_API_URL : (isFile ? "/api" : origin + "/api");

  function getAuthHeaders(withJson) {
    var h = {};
    try {
      var t = localStorage && localStorage.getItem("token");
      if (t) h.Authorization = "Bearer " + t;
    } catch (e) {}
    if (withJson) h["Content-Type"] = "application/json";
    return h;
  }

  function getBookings() {
    return fetch(API + "/bookings", { headers: getAuthHeaders() }).then(function (r) { return r.ok ? r.json() : []; });
  }

  function formatDate(d) {
    if (!d) return "";
    var x = new Date(d);
    var m = x.getMonth() + 1;
    var day = x.getDate();
    var y = x.getFullYear();
    return (m < 10 ? "0" + m : m) + "/" + (day < 10 ? "0" + day : day) + "/" + y;
  }

  function formatShortDate(d) {
    if (!d) return "";
    var x = new Date(d);
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[x.getMonth()] + " " + x.getDate();
  }

  function toDateKey(d) {
    if (!d) return "";
    var x = new Date(d);
    var m = x.getMonth() + 1, day = x.getDate();
    return x.getFullYear() + "-" + (m < 10 ? "0" + m : m) + "-" + (day < 10 ? "0" + day : day);
  }

  function isToday(d) {
    return toDateKey(d) === toDateKey(new Date());
  }

  function getNights(checkIn, checkOut) {
    if (!checkIn || !checkOut) return 0;
    var a = new Date(checkIn), b = new Date(checkOut);
    return Math.max(0, Math.round((b - a) / (24 * 60 * 60 * 1000)));
  }

  // Check-in / check-out
  function postCheckIn(id) {
    return fetch(API + "/bookings/" + id + "/check-in", { method: "POST", headers: getAuthHeaders() }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || "Failed"); });
    });
  }

  function postCheckOut(id) {
    return fetch(API + "/bookings/" + id + "/check-out", { method: "POST", headers: getAuthHeaders() }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || "Failed"); });
    });
  }

  function resendQr(id) {
    return fetch(API + "/bookings/" + id + "/resend-qr", { method: "POST", headers: getAuthHeaders() }).then(function (r) {
      return r.ok ? r.json() : r.json().then(function (e) { throw new Error(e.error || "Failed"); });
    });
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  window.RegaliaStaff = {
    API: API,
    getBookings: getBookings,
    formatDate: formatDate,
    formatShortDate: formatShortDate,
    toDateKey: toDateKey,
    isToday: isToday,
    getNights: getNights,
    postCheckIn: postCheckIn,
    postCheckOut: postCheckOut,
    resendQr: resendQr,
    escapeHtml: escapeHtml,
  };
})();
