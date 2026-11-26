/** Root-relative doc paths and the viewer URLs that carry them. */

export function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

export function relFromPathname(pathname) {
  try {
    const rel = pathname.replace(/^\/view\/?/, "").split("/").map(decodeURIComponent).join("/");
    return rel === "/" ? "" : rel;
  } catch {
    return "";
  }
}

/** The file /api/doc should be asked for, or "" when the URL and initial doc are both empty. */
export function docRequestPath(rel, initial = "") {
  return (rel && rel !== "/" ? rel : "") || initial || "";
}

/** The thread a URL asks to open (?thread=12), or null. */
export function threadFromSearch(search) {
  return Number(new URLSearchParams(search).get("thread")) || null;
}

/** The stored version a URL asks for (?v=3), or null for the file as it is now. */
export function versionFromSearch(search) {
  return Number(new URLSearchParams(search).get("v")) || null;
}
