import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { sha256 } from "peanut/anchors/markdown-block";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { comment, highlighted } from "../helpers/viewer-page.mjs";
import { startViewer } from "../helpers/viewer.mjs";

const SPEC = `# Plan

Keep this paragraph.

Change me.
`;

const chrome = sharedChrome();

async function setup(t, { width = 1800, height = 1100, files = { "agent-brain/plan.md": SPEC, "readme.md": "# Readme\n\nJust a note.\n" } } = {}) {
  const viewer = await startViewer({ files, initial: "agent-brain/plan.md", port: 47800 });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url, { width, height });
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Plan") && !document.querySelector("#edit-spec").hidden, {
    what: "the spec and its Edit button",
  });
  return { viewer, page };
}

async function click(page, selector) {
  const clicked = await page.eval((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    return true;
  }, selector);
  if (!clicked) throw new Error(`Nothing matches ${selector}`);
}

async function fill(page, selector, value) {
  await page.eval(
    (sel, text) => {
      const input = document.querySelector(sel);
      input.focus();
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    selector,
    value,
  );
}

/** Records spec writes the page sends, so a test can see If-Match. */
async function watchSaves(page) {
  await page.eval(() => {
    if (window.__saves) return;
    window.__saves = [];
    const orig = window.fetch.bind(window);
    window.fetch = async (url, init = {}) => {
      const method = (init.method || "GET").toUpperCase();
      if (String(url).includes("/api/specs") && method !== "GET" && method !== "HEAD") {
        const headers = {};
        new Headers(init.headers).forEach((value, key) => {
          headers[key] = value;
        });
        window.__saves.push({ url: String(url), method, headers, body: init.body ?? null });
      }
      return orig(url, init);
    };
  });
}

function saves(page) {
  return page.eval(() => window.__saves);
}

test("Edit saves a spec from a phone and keeps the draft until that succeeds", { skip: chromeMissing }, async (t) => {
  const { viewer, page } = await setup(t, { width: 390, height: 844 });
  // On a phone, Edit lives in the ⋯ menu.
  await click(page, "#more-btn");
  const box = await page.eval(() => {
    const el = document.querySelector('#more-menu [data-proxy="#edit-spec"]');
    const rect = el.getBoundingClientRect();
    return { height: rect.height, top: rect.top, right: rect.right, width: window.innerWidth };
  });
  assert.ok(box.height >= 44, `Edit is ${box.height}px tall`);
  assert.ok(box.right <= box.width + 1, "Edit sits on screen");

  await click(page, '#more-menu [data-proxy="#edit-spec"]');
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the editor" });
  const metrics = await page.eval(() => {
    const save = document.querySelector("#spec-save").getBoundingClientRect();
    const text = getComputedStyle(document.querySelector("#spec-text"));
    return { font: text.fontSize, saveHeight: save.height, saveBottom: save.bottom, height: window.innerHeight };
  });
  assert.equal(metrics.font, "16px");
  assert.ok(metrics.saveHeight >= 44, `Save is ${metrics.saveHeight}px tall`);
  assert.ok(metrics.saveBottom <= metrics.height + 1, "Save sits above the bottom of the screen");

  const draft = "# Plan\n\nKeep this paragraph.\n\nPhone edit.\n";
  await watchSaves(page);
  await fill(page, "#spec-text", draft);
  await page.waitFor((text) => (localStorage.getItem("mdview.specDrafts") || "").includes(text), { what: "the draft to be stored" }, "Phone edit.");
  await page.goto(viewer.url);
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden && document.querySelector("#spec-text").value.includes("Phone edit."), {
    what: "the draft to reopen after a reload",
  });

  await watchSaves(page);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#spec-editor").hidden && document.querySelector("#doc").textContent.includes("Phone edit."), {
    what: "the saved spec to render",
  });
  assert.equal(await fs.readFile(viewer.file("agent-brain/plan.md"), "utf8"), draft);
  assert.equal(await page.eval(() => localStorage.getItem("mdview.specEditor")), null);
  const [put] = await saves(page);
  assert.equal(put.method, "PUT");
  assert.equal(put.headers["if-match"], `"${sha256(SPEC)}"`);
  assert.equal(JSON.parse(put.body).content, draft);
});

test("a 412 shows the draft and the current text, and overwrite uses the text just reviewed", { skip: chromeMissing }, async (t) => {
  const { viewer, page } = await setup(t, { width: 390, height: 844 });
  await watchSaves(page);
  await click(page, "#edit-spec");
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the editor" });
  const mine = "# Plan\n\nMine one.\n";
  await fill(page, "#spec-text", mine);
  const serverOne = "# Plan\n\nServer one.\n";
  await viewer.write("agent-brain/plan.md", serverOne);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#spec-conflict-note")?.textContent.includes("Your draft is still here"), {
    what: "the conflict note",
  });

  const stacked = await page.eval(() => {
    const current = document.querySelector("#spec-current-pane").getBoundingClientRect();
    const draft = document.querySelector("#spec-draft-pane").getBoundingClientRect();
    return {
      currentTop: current.top,
      draftTop: draft.top,
      sameLeft: Math.abs(current.left - draft.left) < 8,
      currentText: document.querySelector("#spec-current").textContent,
      draftText: document.querySelector("#spec-text").value,
    };
  });
  assert.equal(stacked.currentText, serverOne);
  assert.equal(stacked.draftText, mine);
  assert.ok(stacked.sameLeft, "the two texts share a column");
  assert.ok(stacked.draftTop >= stacked.currentTop + 20, "the draft sits below the current text");

  await page.resize(1100, 800);
  await page.waitFor(() => {
    const current = document.querySelector("#spec-current-pane").getBoundingClientRect();
    const draft = document.querySelector("#spec-draft-pane").getBoundingClientRect();
    return draft.left >= current.right - 2 && Math.abs(current.top - draft.top) < 30;
  }, { what: "the two texts to sit side by side" });

  await click(page, "#spec-copy-draft");
  assert.equal(await page.eval(() => document.querySelector("#spec-text").value), mine);

  const serverTwo = "# Plan\n\nServer two.\n";
  await viewer.write("agent-brain/plan.md", serverTwo);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#spec-current").textContent.includes("Server two."), { what: "the newer current text" });
  assert.equal(await page.eval(() => document.querySelector("#spec-text").value), mine);
  const written = await saves(page);
  assert.equal(written[0].headers["if-match"], `"${sha256(SPEC)}"`);
  assert.equal(written[1].headers["if-match"], `"${sha256(serverOne)}"`);
  assert.equal(await fs.readFile(viewer.file("agent-brain/plan.md"), "utf8"), serverTwo);

  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#spec-editor").hidden && document.querySelector("#doc").textContent.includes("Mine one."), {
    what: "the overwrite to land",
  });
  assert.equal(await fs.readFile(viewer.file("agent-brain/plan.md"), "utf8"), mine);
  const after = await saves(page);
  assert.equal(after[2].headers["if-match"], `"${sha256(serverTwo)}"`);
  assert.equal(await page.eval(() => localStorage.getItem("mdview.specDrafts")), "{}");
});

test("reload the latest keeps the replaced draft until a later save", { skip: chromeMissing }, async (t) => {
  const { viewer, page } = await setup(t);
  await click(page, "#edit-spec");
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the editor" });
  const mine = "# Plan\n\nMine two.\n";
  await fill(page, "#spec-text", mine);
  const latest = "# Plan\n\nServer three.\n";
  await viewer.write("agent-brain/plan.md", latest);
  await click(page, "#spec-save");
  await page.waitFor(() => !document.querySelector("#spec-reload").hidden, { what: "Reload the latest" });
  await click(page, "#spec-reload");
  await page.waitFor(() => document.querySelector("#spec-reload").hidden && document.querySelector("#spec-text").value.includes("Server three."), {
    what: "the editor to take the latest text",
  });
  assert.equal(await page.eval(() => document.querySelector("#spec-previous").hidden), false);
  assert.match(await page.eval(() => localStorage.getItem("mdview.specDrafts")), /Mine two/);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#spec-editor").hidden, { what: "the reloaded text to save" });
  assert.equal(await fs.readFile(viewer.file("agent-brain/plan.md"), "utf8"), latest);
  assert.equal(await page.eval(() => localStorage.getItem("mdview.specDrafts")), "{}");
});

test("New spec reuses the editor, and an existing key is a conflict", { skip: chromeMissing }, async (t) => {
  const { viewer, page } = await setup(t, { width: 390, height: 844 });
  await watchSaves(page);
  await click(page, "#new-spec");
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden && getComputedStyle(document.querySelector(".spec-key-field")).display !== "none", {
    what: "the new-spec editor",
  });
  const key = "agent-brain/fresh.md";
  const created = "# Fresh\n\nHello from the phone.\n";
  await fill(page, "#spec-key", key);
  await fill(page, "#spec-text", created);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Fresh"), { what: "the new spec to render" });
  assert.equal(await fs.readFile(viewer.file(key), "utf8"), created);
  const [post] = await saves(page);
  assert.equal(post.method, "POST");
  assert.equal(post.url.endsWith("/api/specs"), true);
  assert.equal(post.headers["if-match"], undefined);

  await click(page, "#new-spec");
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the editor again" });
  await fill(page, "#spec-key", key);
  const other = "# Fresh\n\nA second try.\n";
  await fill(page, "#spec-text", other);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#spec-current")?.textContent.includes("Hello from the phone."), { what: "the existing spec" });
  assert.equal(await page.eval(() => document.querySelector("#spec-text").value), other);
  assert.equal(await fs.readFile(viewer.file(key), "utf8"), created);
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("A second try."), { what: "the overwrite of the new spec" });
  assert.equal(await fs.readFile(viewer.file(key), "utf8"), other);
});

test("a file that is not a spec has no Edit button", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t);
  await click(page, 'a.file[data-path="readme.md"]');
  await page.waitFor(() => document.querySelector("#doc h1")?.textContent.includes("Readme"), { what: "the readme" });
  assert.equal(await page.eval(() => document.querySelector("#edit-spec").hidden), true);
  assert.equal(await page.eval(() => document.querySelector("#new-spec").hidden), false);
});

test("comments re-anchor after a save", { skip: chromeMissing }, async (t) => {
  const { page } = await setup(t);
  await comment(page, "Keep this paragraph", "Please keep this.");
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the highlight" });

  await click(page, "#edit-spec");
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the editor" });
  await page.eval(() => {
    const input = document.querySelector("#spec-text");
    input.value = `${input.value.trimEnd()}\n\nAdded later.\n`;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("Added later."), { what: "the added paragraph" });
  await page.waitFor(() => CSS.highlights.get("mdview-comment-open")?.size === 1, { what: "the comment to stay on its paragraph" });
  assert.deepEqual(await highlighted(page), ["Keep this paragraph"]);
  assert.equal(await page.eval(() => document.querySelector(".chip-outdated")), null);

  await click(page, "#edit-spec");
  await page.waitFor(() => !document.querySelector("#spec-editor").hidden, { what: "the editor again" });
  await page.eval(() => {
    const input = document.querySelector("#spec-text");
    input.value = input.value.replace("Keep this paragraph.", "Keep this paragraph, edited.");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(page, "#spec-save");
  await page.waitFor(() => document.querySelector("#doc").textContent.includes("Keep this paragraph, edited."), { what: "the edited paragraph" });
  await page.waitFor(
    () => document.querySelector("#rail")?.textContent.includes("on older versions") || document.querySelector(".chip-outdated"),
    { what: "the thread to be outdated" },
  );
  const older = await page.eval(() => document.querySelector('#rail [data-action="list"]'));
  if (older) await click(page, '#rail [data-action="list"]');
  await page.waitFor(() => document.querySelector("#rail").textContent.includes("Please keep this."), { what: "the comment text" });
  assert.match(await page.eval(() => document.querySelector("#rail").textContent), /Keep this paragraph/);
});
