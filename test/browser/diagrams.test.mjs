import { test } from "node:test";
import assert from "node:assert/strict";
import { chromeMissing, sharedChrome } from "../helpers/browser.mjs";
import { startViewer } from "../helpers/viewer.mjs";
import { click, select } from "../helpers/viewer-page.mjs";

const DOC = `# Diagrams

\`\`\`mermaid
flowchart LR
  a[Alpha node] --> b[Beta node]
\`\`\`

The source sits below.

\`\`\`mermaid
flowchart TD
  a --> (((
\`\`\`
`;

const chrome = sharedChrome();

/** A viewer on doc.md and a tab on it. */
async function setup(t, port) {
  const viewer = await startViewer({ files: { "doc.md": DOC }, initial: "doc.md", port });
  t.after(() => viewer.close());
  const page = await (await chrome()).open(viewer.url);
  t.after(() => page.close());
  t.after(() => assert.deepEqual(page.errors, [], "the page threw"));
  await page.waitFor(
    () => document.querySelector("#doc figure.mermaid-diagram svg") && document.querySelector("#doc figure.mermaid-diagram.failed"),
    { what: "the diagram and the failure", timeout: 15000 },
  );
  return page;
}

const lightboxOpen = (page) => page.eval(() => document.querySelector("#lightbox").open);

async function openDiagram(page) {
  await click(page, "#doc figure.mermaid-diagram svg");
  await page.waitFor(() => document.querySelector("#lightbox").open, { what: "the diagram to open" });
}

async function mouseClick(page, x, y) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
}

test("a diagram opens over the doc, scaled to fit, and Escape closes it", { skip: chromeMissing }, async (t) => {
  const page = await setup(t, 47530);
  const before = await page.eval(() => location.href);
  await openDiagram(page);

  const shown = await page.eval(() => {
    const svg = document.querySelector("#lightbox-diagram svg");
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pageSvg = document.querySelector("#doc figure.mermaid-diagram svg");
    const pageIds = new Set([...pageSvg.querySelectorAll("[id]")].map((el) => el.id));
    if (pageSvg.id) pageIds.add(pageSvg.id);
    const cloneIds = new Set([...svg.querySelectorAll("[id]")].map((el) => el.id));
    if (svg.id) cloneIds.add(svg.id);
    const text = `${svg.outerHTML}`;
    const refs = [...text.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
    return {
      tag: svg.tagName,
      imgSrc: document.querySelector("#lightbox-img").getAttribute("src"),
      label: document.querySelector("#lightbox").getAttribute("aria-label"),
      w: rect.width,
      h: rect.height,
      maxW: innerWidth - 96,
      maxH: innerHeight - 96,
      aspect: rect.width / rect.height,
      vb: vb.width / vb.height,
      overlap: [...cloneIds].filter((id) => pageIds.has(id)),
      refs,
      refsInside: refs.every((id) => cloneIds.has(id)),
      onTop: document.querySelector("#lightbox-diagram").contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
    };
  });
  assert.equal(shown.tag, "svg");
  assert.equal(shown.imgSrc, null);
  assert.equal(shown.label, "Diagram");
  assert.deepEqual(shown.overlap, []);
  assert.ok(shown.refs.length > 0, "the diagram uses arrow markers");
  assert.equal(shown.refsInside, true);
  assert.ok(shown.w >= shown.maxW - 2 || shown.h >= shown.maxH - 2, `fills the dialog, got ${shown.w}x${shown.h} of ${shown.maxW}x${shown.maxH}`);
  assert.ok(shown.w <= shown.maxW + 1 && shown.h <= shown.maxH + 1);
  assert.ok(Math.abs(shown.aspect - shown.vb) / shown.vb < 0.02, `aspect ${shown.aspect} vs viewBox ${shown.vb}`);
  assert.equal(shown.onTop, true);
  assert.equal(await page.eval(() => location.href), before);

  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "Escape to close the diagram" });
  await page.waitFor(
    () => !document.querySelector("#lightbox-diagram svg") && !document.querySelector("#lightbox-img").hasAttribute("src"),
    { what: "the closed diagram to be dropped" },
  );
});

test("a click off the diagram or on the close button closes it, and a click on the diagram does not", { skip: chromeMissing }, async (t) => {
  const page = await setup(t, 47531);
  await openDiagram(page);

  const center = await page.eval(() => {
    const box = document.querySelector("#lightbox-diagram svg").getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  await mouseClick(page, center.x, center.y);
  assert.equal(await lightboxOpen(page), true, "a click on the diagram keeps it open");

  await mouseClick(page, 10, center.y);
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "a click outside to close the diagram" });

  await openDiagram(page);
  await click(page, "#lightbox-close");
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "the close button to close the diagram" });
});

test("the source toggle, a text selection, and a diagram that failed do not open it, and a theme change closes it", { skip: chromeMissing }, async (t) => {
  const page = await setup(t, 47532);

  await click(page, "#doc details.mermaid-source summary");
  assert.equal(await lightboxOpen(page), false, "the source toggle stays a toggle");

  await select(page, "Alpha node");
  await click(page, "#doc figure.mermaid-diagram svg");
  assert.equal(await lightboxOpen(page), false, "a text selection does not open the diagram");

  await page.eval(() => getSelection().removeAllRanges());
  await click(page, "#doc figure.mermaid-diagram.failed");
  assert.equal(await lightboxOpen(page), false, "a diagram that did not parse does not open");

  const theme = await page.eval(() => document.documentElement.dataset.theme);
  await openDiagram(page);
  for (let i = 0; i < 3; i++) {
    await click(page, "#theme");
    if ((await page.eval(() => document.documentElement.dataset.theme)) !== theme) break;
  }
  await page.waitFor(() => !document.querySelector("#lightbox").open, { what: "a theme change to close the diagram" });
});
