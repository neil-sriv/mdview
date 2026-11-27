// A classic script that runs before the app's scripts. When they cannot run, the page
// stays blank until a hard refresh. Two ways that happened with a saved shell:
// - Firefox blocked every script an older service worker handed over from its cache,
//   because a Response rebuilt in the worker has no URL to match script-src /static/js/.
// - A module from one deploy imported a name another deploy's saved file lacks, so the
//   module graph failed to link.
// Either way, when the server is reachable, drop the saved shell, let the current worker
// take over, and reload once. This file is fetched fresh by older workers, which never
// saved it.
(function () {
  var KEY = "mdview.recovered";
  var started = false;
  var recovering = false;
  document.addEventListener("DOMContentLoaded", function () {
    started = true;
  });

  function isLinkError(event) {
    var error = event.error;
    var message = String(event.message || (error && error.message) || "");
    if (typeof SyntaxError === "function" && error instanceof SyntaxError) return true;
    return /SyntaxError|export named|binding name|indirect export/i.test(message);
  }

  function isAppScript(target) {
    return target && target.tagName === "SCRIPT" && /\/static\/js\//.test(target.src || "");
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function dropShell() {
    if (!window.caches) return Promise.resolve();
    return caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name.indexOf("mdview-shell") === 0;
      }).map(function (name) {
        return caches.delete(name);
      }));
    }).catch(function () {});
  }

  // A newer worker that is installing or waiting skips waiting; give it a moment to take over.
  function newerWorker() {
    var sw = navigator.serviceWorker;
    if (!sw) return Promise.resolve();
    return sw.getRegistration().then(function (reg) {
      if (!reg) return;
      return Promise.resolve(reg.update()).catch(function () {}).then(function () {
        if (!reg.installing && !reg.waiting) return;
        return Promise.race([
          new Promise(function (resolve) {
            sw.addEventListener("controllerchange", resolve, { once: true });
          }),
          wait(3000),
        ]);
      });
    }).catch(function () {});
  }

  function recover() {
    if (recovering) return;
    recovering = true;
    try {
      var last = Number(sessionStorage.getItem(KEY));
      if (last && Date.now() - last < 60000) return;
    } catch (e) {
      return;
    }
    // /sw.js never goes through the worker: if it answers, the server is up and the shell
    // can be refetched. Offline, the saved shell is all there is, so it stays.
    var controller = new AbortController();
    setTimeout(function () {
      controller.abort();
    }, 3000);
    fetch("/sw.js", { cache: "no-store", signal: controller.signal })
      .then(function (res) {
        if (!res.ok) return;
        try {
          sessionStorage.setItem(KEY, String(Date.now()));
        } catch (e) {
          return;
        }
        return dropShell()
          .then(newerWorker)
          .then(dropShell)
          .then(function () {
            location.reload();
          });
      })
      .catch(function () {});
  }

  addEventListener("error", function (event) {
    if (started) return;
    if (event instanceof ErrorEvent ? isLinkError(event) : isAppScript(event.target)) recover();
  }, true);
})();
