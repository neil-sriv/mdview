import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { startViewer } from "../helpers/viewer.mjs";

const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} is long enough to scroll through on a phone.`).join("\n\n");

const chrome = sharedChrome();

async function setup(t, { width = 390, height = 844 } = {}) {
  const viewer = await startViewer({
    files: { "agent-brain/plan.md": `# Plan\n\n${LONG}\n`, "readme.md": "# Readme\n" },
    initial: "agent-brain/plan.md",
    port: 47850,
  });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url, { width, height });
  // Tabs share one Chrome and port, so leave no theme or open editor behind for the next test.
  t.after(() => page.eval(() => localStorage.clear()));
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  // A phone: mobile mode, so the page lays out as one.
  await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 820 });
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan") && !document.querySelector("#edit-spec").hidden, {
    what: "the spec",
  });
  return { viewer, page };
}

function click(page, selector) {
  return page.eval((sel) => {
    document.querySelector(sel).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  }, selector);
}

/** Boxes of the topbar's visible controls, by id. */
function topbarControls(page) {
  return page.eval(() => {
    const out = {};
    for (const el of document.querySelectorAll(".topbar button, .topbar a")) {
      if (!el.id || el.closest("#more-menu")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width && getComputedStyle(el).display !== "none") out[el.id] = { width: rect.width, height: rect.height, right: rect.right };
    }
    return { controls: out, width: innerWidth, overflow: document.querySelector(".topbar").scrollWidth > innerWidth };
  });
}

let touchId = 0;

/**
 * A one-finger drag through `points`: TouchEvents built in the page and sent
 * to whatever sits under each point, as a browser would. (CDP's touch input
 * leaves phantom fingers down after sideways drags in headless Chrome.)
 */
async function drag(page, points) {
  await page.eval(
    (pts, id) => {
      const target = document.elementFromPoint(pts[0].x, pts[0].y);
      const touch = (p) => new Touch({ identifier: id, target, clientX: p.x, clientY: p.y });
      const fire = (type, p, active) => {
        const t = touch(p);
        target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: active ? [t] : [], targetTouches: active ? [t] : [], changedTouches: [t] }));
      };
      fire("touchstart", pts[0], true);
      for (const p of pts.slice(1)) fire("touchmove", p, true);
      fire("touchend", pts.at(-1), false);
    },
    points,
    ++touchId,
  );
}

/** Points from `from` to `to` in `steps` even steps. */
function line(from, to, steps = 12) {
  return Array.from({ length: steps + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }));
}

const isOpen = (page) => page.eval(() => document.documentElement.classList.contains("sidebar-open"));

test("on a phone, Edit, New, Copy and Theme sit in the ⋯ menu, and the topbar fits with 44px targets", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { width: 360, height: 780 });
  const { controls, width, overflow } = await topbarControls(page);
  assert.equal(overflow, false, "the topbar does not overflow");
  assert.deepEqual(Object.keys(controls).sort(), ["crumbs", "more-btn", "toggle-sidebar"]);
  for (const id of ["toggle-sidebar", "more-btn"]) {
    assert.ok(controls[id].width >= 44 && controls[id].height >= 44, `${id} is ${controls[id].width}×${controls[id].height}`);
  }
  assert.ok(controls["more-btn"].right <= width + 1, "⋯ sits on screen");

  await click(page, "#more-btn");
  const items = await page.eval(() =>
    [...document.querySelectorAll("#more-menu [role=menuitem]")]
      .filter((el) => !el.hidden)
      .map((el) => ({ text: el.textContent.trim(), height: el.getBoundingClientRect().height })),
  );
  assert.deepEqual(
    items.map((item) => item.text),
    ["Edit this spec", "New spec", "Copy Markdown", "Theme: auto"],
  );
  for (const item of items) assert.ok(item.height >= 44, `${item.text} is ${item.height}px tall`);
  assert.equal(await page.eval(() => document.querySelector("#more-btn").getAttribute("aria-expanded")), "true");

  // Theme changes in place and keeps the menu open.
  await click(page, '#more-menu [data-proxy="#theme"]');
  assert.equal(await page.eval(() => document.querySelector("#more-theme").textContent), "light");
  assert.equal(await page.eval(() => document.querySelector("#more-menu").hidden), false);

  // A tap outside closes it, and New opens the editor and closes it too.
  await click(page, "#doc");
  assert.equal(await page.eval(() => document.querySelector("#more-menu").hidden), true);
  await click(page, "#more-btn");
  await click(page, '#more-menu [data-proxy="#new-spec"]');
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the new-spec editor" });
  assert.equal(await page.eval(() => document.querySelector("#more-menu").hidden), true);
  // Cancel, or the next test's page reopens this editor.
  await click(page, "#spec-cancel");
  await page.waitFor(() => document.querySelector("#spec-editor").hidden, { what: "the editor to close" });
});

test("on a wide screen, the topbar keeps its buttons and has no ⋯ menu", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t, { width: 1400, height: 900 });
  const { controls } = await topbarControls(page);
  for (const id of ["edit-spec", "new-spec", "copy-md", "theme", "toggle-sidebar"]) assert.ok(controls[id], `${id} shows`);
  assert.equal(controls["more-btn"], undefined);
});

test("a swipe from the left edge opens the file list, and a swipe left closes it", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t);
  // A vertical drag from the edge scrolls and leaves the list shut.
  await drag(page, line({ x: 8, y: 700 }, { x: 14, y: 250 }));
  assert.equal(await isOpen(page), false, "a vertical drag does not open the list");

  // A short swipe from the edge, under the threshold, does nothing.
  await drag(page, line({ x: 4, y: 400 }, { x: 40, y: 400 }, 4));
  assert.equal(await isOpen(page), false, "a short swipe does not open the list");

  await drag(page, line({ x: 4, y: 400 }, { x: 140, y: 405 }));
  await page.waitFor(() => document.documentElement.classList.contains("sidebar-open"), { what: "the list to open" });

  // Swipe left on the backdrop closes it.
  await drag(page, line({ x: 360, y: 400 }, { x: 220, y: 402 }));
  await page.waitFor(() => !document.documentElement.classList.contains("sidebar-open"), { what: "the list to close from the backdrop" });

  // Swipe left on the list itself closes it too.
  await drag(page, line({ x: 4, y: 400 }, { x: 140, y: 400 }));
  await page.waitFor(() => document.documentElement.classList.contains("sidebar-open"), { what: "the list to reopen" });
  await drag(page, line({ x: 250, y: 300 }, { x: 100, y: 300 }));
  await page.waitFor(() => !document.documentElement.classList.contains("sidebar-open"), { what: "the list to close from itself" });

  // A tap on the backdrop closes it.
  await click(page, "#toggle-sidebar");
  assert.equal(await isOpen(page), true);
  await click(page, "#sidebar-backdrop");
  assert.equal(await isOpen(page), false, "tapping the backdrop closes the list");

  // Starting away from the edge does nothing.
  await drag(page, line({ x: 120, y: 400 }, { x: 260, y: 400 }));
  assert.equal(await isOpen(page), false, "a swipe from mid-screen does not open the list");
});

test("an edge swipe while text is selected leaves the list shut, so selection handles still drag", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t);
  await page.eval(() => {
    const text = [...document.querySelectorAll("#doc p")][1].firstChild;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 9);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await drag(page, line({ x: 4, y: 400 }, { x: 140, y: 400 }));
  assert.equal(await isOpen(page), false);
});
