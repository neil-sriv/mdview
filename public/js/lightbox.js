/**
 * Pictures and mermaid diagrams in the doc open over the page, in a <dialog>.
 * Escape, the close button, or a click anywhere off the picture or diagram
 * closes it. A picture inside a link stays a link, and ⌘ or Ctrl-click still
 * opens that picture in a new tab. A diagram is a copy of its SVG, so it stays
 * sharp, and its ids are renamed so arrow markers don't point at the copy in
 * the page. A pinch still zooms it: nothing here captures the touch.
 */
import { $, root } from "./dom.js";

// Attributes whose value is a list of ids, with no leading #.
const ID_REFS = new Set(["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns", "aria-flowto"]);

export function closeLightbox() {
  const box = $("#lightbox");
  if (!box.open) return false;
  box.close();
  return true;
}

function resetLightbox() {
  const img = $("#lightbox-img");
  img.removeAttribute("src");
  img.alt = "";
  img.hidden = true;
  const diagram = $("#lightbox-diagram");
  diagram.replaceChildren();
  diagram.hidden = true;
  diagram.style.removeProperty("--aspect");
}

function openImage(img) {
  const box = $("#lightbox");
  const diagram = $("#lightbox-diagram");
  diagram.replaceChildren();
  diagram.hidden = true;
  diagram.style.removeProperty("--aspect");
  const shown = $("#lightbox-img");
  shown.hidden = false;
  shown.src = img.currentSrc || img.src;
  shown.alt = img.alt;
  box.setAttribute("aria-label", img.alt ? `Image: ${img.alt}` : "Image");
  box.showModal();
}

function diagramAspect(svg) {
  const box = svg.viewBox?.baseVal;
  if (box?.width > 0 && box?.height > 0) return box.width / box.height;
  const bounds = svg.getBBox();
  return bounds.width > 0 && bounds.height > 0 ? bounds.width / bounds.height : 1;
}

/** A copy of `svg` whose ids, and every reference to them, can't collide with the one still in the page. */
function cloneDiagram(svg) {
  const clone = svg.cloneNode(true);
  const ids = new Set([...clone.querySelectorAll("[id]")].map((el) => el.id));
  if (clone.id) ids.add(clone.id);
  const rename = (id) => `lightbox-${id}`;
  const rewriteHash = (value) =>
    value.replace(/#([A-Za-z_][\w:.-]*)/g, (full, id) => (ids.has(id) ? `#${rename(id)}` : full));
  const rewriteList = (value) =>
    value
      .split(/\s+/)
      .map((id) => (ids.has(id) ? rename(id) : id))
      .join(" ");
  const visit = (el) => {
    for (const attr of [...el.attributes]) {
      if (attr.name === "id" || !attr.value) continue;
      let next = attr.value;
      if (ID_REFS.has(attr.name)) next = rewriteList(attr.value);
      else if (attr.value.includes("#")) next = rewriteHash(attr.value);
      if (next !== attr.value) attr.value = next;
    }
    for (const child of el.childNodes) {
      if (child.nodeType === Node.ELEMENT_NODE) visit(child);
      else if (child.nodeType === Node.TEXT_NODE && child.data.includes("#")) child.data = rewriteHash(child.data);
    }
  };
  visit(clone);
  if (clone.id) clone.id = rename(clone.id);
  for (const el of clone.querySelectorAll("[id]")) el.id = rename(el.id);
  // Mermaid caps the svg at its laid-out size. Drop that so the copy can grow to the viewport.
  clone.style.removeProperty("max-width");
  clone.style.removeProperty("max-height");
  clone.style.removeProperty("width");
  clone.style.removeProperty("height");
  if (clone.getAttribute("style") === "") clone.removeAttribute("style");
  clone.setAttribute("width", "100%");
  clone.setAttribute("height", "100%");
  if (!(clone.viewBox?.baseVal?.width > 0)) {
    const bounds = svg.getBBox();
    clone.setAttribute("viewBox", `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`);
  }
  return clone;
}

function openDiagram(svg) {
  const box = $("#lightbox");
  const shown = $("#lightbox-img");
  shown.removeAttribute("src");
  shown.alt = "";
  shown.hidden = true;
  const diagram = $("#lightbox-diagram");
  diagram.style.setProperty("--aspect", String(diagramAspect(svg)));
  diagram.replaceChildren(cloneDiagram(svg));
  diagram.hidden = false;
  box.setAttribute("aria-label", "Diagram");
  box.showModal();
}

export function watchImages() {
  $("#doc").addEventListener("click", (event) => {
    if (event.button !== 0 || !getSelection().isCollapsed) return;
    const img = event.target.closest("img");
    if (img) {
      if (img.closest("a[href]")) return;
      if (event.metaKey || event.ctrlKey) {
        window.open(img.currentSrc || img.src, "_blank", "noopener");
        return;
      }
      event.preventDefault();
      openImage(img);
      return;
    }
    // The source toggle is a sibling of the figure, and a failed diagram has no svg, so neither reaches here.
    const svg = event.target.closest("figure.mermaid-diagram svg");
    if (!svg || event.target.closest("a[href]") || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    openDiagram(svg);
  });

  const box = $("#lightbox");
  box.addEventListener("click", (event) => {
    if (!event.target.closest("#lightbox-img, #lightbox-diagram")) box.close();
  });
  // The dialog closes itself on Escape. Stop the key here so it does not also close comments behind it.
  box.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  box.addEventListener("close", resetLightbox);
  // The page redraws diagrams in the other palette. The copy over it would be stale, so close it.
  new MutationObserver(() => {
    if (box.open && !$("#lightbox-diagram").hidden) box.close();
  }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
