/**
 * Phone chrome: the ⋯ menu that holds the topbar's rarely used actions, and
 * edge swipes that open and close the file list.
 *
 * The menu's items click the real buttons (Edit, New, Copy, Theme), so those
 * keep one set of listeners and their own hidden state. CSS shows the menu
 * button and hides the real buttons only under the 820px breakpoint.
 *
 * Swipes use passive touch listeners and never call preventDefault, so
 * vertical scrolling, text selection and long-press-to-comment work as
 * before. A swipe opens the list only when it starts within EDGE px of the
 * left edge, with no text selected, and travels THRESHOLD px mostly sideways.
 * iOS Safari (and Chrome on iOS) claim a left-edge swipe for Back when there
 * is history to go back to; the page then gets touchcancel and the list stays
 * shut. The ☰ button still works there, and the home-screen app has no Back
 * swipe, so the gesture works in it.
 */
import { $, root } from "./dom.js";
import { closeSidebar, NARROW, showSidebar } from "./sidebar.js";

export const EDGE = 24;
export const THRESHOLD = 60;
/** How much more sideways than vertical a swipe must be. */
const SLOPE = 1.5;

function menu() {
  return $("#more-menu");
}

export function closeMoreMenu() {
  const open = !menu().hidden;
  menu().hidden = true;
  $("#more-btn").setAttribute("aria-expanded", "false");
  return open;
}

function syncMenu() {
  for (const item of menu().querySelectorAll("[data-proxy]")) item.hidden = Boolean($(item.dataset.proxy)?.hidden);
  $("#more-theme").textContent = $("#theme").dataset.pref || "auto";
}

function toggleMoreMenu() {
  if (!menu().hidden) {
    closeMoreMenu();
    return;
  }
  syncMenu();
  menu().hidden = false;
  $("#more-btn").setAttribute("aria-expanded", "true");
  menu().querySelector("[data-proxy]:not([hidden])")?.focus({ preventScroll: true });
}

/** True while a menu item clicks its real button, so that click does not count as one outside the menu. */
let proxying = false;

function watchMenu() {
  $("#more-btn").addEventListener("click", toggleMoreMenu);
  menu().addEventListener("click", (event) => {
    const item = event.target.closest("[data-proxy]");
    if (!item) return;
    proxying = true;
    try {
      $(item.dataset.proxy)?.click();
    } finally {
      proxying = false;
    }
    if (item.hasAttribute("data-keep-open")) syncMenu();
    else closeMoreMenu();
  });
  document.addEventListener("click", (event) => {
    if (!proxying && !menu().hidden && !event.target.closest("#more-menu, #more-btn")) closeMoreMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && closeMoreMenu()) $("#more-btn").focus();
  });
  // Widening the window past the breakpoint hides the button, so drop the menu with it.
  NARROW.addEventListener("change", closeMoreMenu);
}

/** Whether a modal (the editor, the composer, the lightbox) owns the screen, so swipes should not move the list. */
function busy() {
  return !$("#spec-editor").hidden || !$("#composer").hidden || $("#lightbox").open;
}

function watchSwipes() {
  let swipe = null;
  $("#sidebar-backdrop").addEventListener("click", closeSidebar);
  document.addEventListener(
    "touchstart",
    (event) => {
      swipe = null;
      if (!NARROW.matches || event.touches.length !== 1 || busy()) return;
      const touch = event.touches[0];
      const open = root.classList.contains("sidebar-open");
      if (open) {
        if (!event.target.closest?.("#sidebar, #sidebar-backdrop")) return;
        swipe = { action: "close", id: touch.identifier, x: touch.clientX, y: touch.clientY };
      } else {
        // A drag of a selection handle near the edge is selecting, not swiping.
        if (touch.clientX > EDGE || !getSelection().isCollapsed) return;
        swipe = { action: "open", id: touch.identifier, x: touch.clientX, y: touch.clientY };
      }
    },
    { passive: true },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (!swipe) return;
      // Follow the finger that started the swipe. A second finger landing resets it in touchstart.
      const touch = [...event.changedTouches].find((t) => t.identifier === swipe.id);
      if (!touch) return;
      const dx = touch.clientX - swipe.x;
      const dy = touch.clientY - swipe.y;
      // Mostly vertical: a scroll. Let it be, for the rest of this touch.
      if (Math.abs(dy) > 10 && Math.abs(dy) * SLOPE > Math.abs(dx)) {
        swipe = null;
        return;
      }
      if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * SLOPE) return;
      if (swipe.action === "open" && dx > 0) showSidebar();
      else if (swipe.action === "close" && dx < 0) closeSidebar();
      else return;
      swipe = null;
    },
    { passive: true },
  );
  const end = () => {
    swipe = null;
  };
  document.addEventListener("touchend", end, { passive: true });
  document.addEventListener("touchcancel", end, { passive: true });
}

export function initMobile() {
  watchMenu();
  watchSwipes();
}
