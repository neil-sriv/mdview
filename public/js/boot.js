// A classic script in <head>: it applies the saved theme and file-list state before the first paint, so neither flashes.
(function () {
  var pref = localStorage.getItem("mdview.theme") || "auto";
  var dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.getElementById("hljs-light").disabled = dark;
  document.getElementById("hljs-dark").disabled = !dark;
  if (localStorage.getItem("mdview.sidebar") === "hidden") document.documentElement.classList.add("no-sidebar");
})();

// The installed app. Registration is a no-op outside a secure context, so a plain LAN http host stays a normal page.
(function () {
  var offline = { on: false, at: "" };

  function clock(iso) {
    var date = new Date(iso);
    if (!iso || isNaN(date.getTime())) return "";
    var time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (date.toDateString() === new Date().toDateString()) return time;
    return time + " on " + date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  function applyOffline() {
    var root = document.documentElement;
    var banner = document.getElementById("offline");
    var status = document.getElementById("offline-status");
    var live = document.getElementById("live");
    if (!offline.on) {
      root.removeAttribute("data-offline");
      root.style.removeProperty("--offline-h");
      if (banner) banner.hidden = true;
      if (live && live.title.indexOf("offline") !== -1) {
        live.title = live.classList.contains("on")
          ? "Live reload: on. The page updates when the file changes."
          : "Live reload: reconnecting";
      }
      return;
    }
    root.dataset.offline = "1";
    if (status) status.textContent = offline.at ? "Offline — saved at " + clock(offline.at) : "Offline — saved copy";
    if (banner) {
      banner.hidden = false;
      root.style.setProperty("--offline-h", banner.offsetHeight + "px");
    }
    if (live) {
      live.classList.remove("on");
      live.title = "Live reload: off while offline";
    }
  }

  // fromDoc is the rendered document's own cache time. A shell save must not replace it.
  function showOffline(cachedAt, fromDoc) {
    offline.on = true;
    if ((fromDoc && cachedAt) || !offline.at) offline.at = cachedAt || offline.at;
    applyOffline();
  }

  window.mdviewOffline = function (cachedAt) {
    showOffline(cachedAt, true);
  };
  window.mdviewOnline = function () {
    offline.on = false;
    offline.at = "";
    applyOffline();
  };
  document.addEventListener("DOMContentLoaded", applyOffline);

  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", function (event) {
    var data = event.data || {};
    if (data.type === "synced") window.__mdviewSync = data;
    else if (data.type === "online") window.mdviewOnline();
    else if (data.type === "offline") showOffline(data.cachedAt, data.doc);
  });

  // A sync refetches the page, the catalog and any doc that changed; the hashed build
  // comes from the cache. Focus and the timer ask at most once a minute, and the timer
  // only while the tab is shown. Coming back online always asks.
  var SYNC_GAP_MS = 60000;
  var lastSync = 0;
  function requestSync(force) {
    if (force !== true && Date.now() - lastSync < SYNC_GAP_MS) return;
    lastSync = Date.now();
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg.active) reg.active.postMessage({ type: "sync" });
    }).catch(function () {});
  }
  navigator.serviceWorker.register("/sw.js").then(function () {
    requestSync(true);
  }).catch(function () {});
  addEventListener("focus", requestSync);
  addEventListener("online", function () {
    requestSync(true);
  });
  setInterval(function () {
    if (document.visibilityState === "visible") requestSync();
  }, 5 * SYNC_GAP_MS);
})();
