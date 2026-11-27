import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "./index.js";

// The page links the hashed build from worker/prepare-assets.mjs. Those files are
// immutable; the unhashed paths older pages and service workers ask for still work.
const HOST = "https://specs.neilsriv.tech";
const OPEN = { ...env, AUTH_MODE: "open", ALLOW_ANONYMOUS_HUMAN: "1", HUMAN_EMAILS: "neil@neilsriv.tech" };

describe("hashed assets", () => {
  it("serves a page that links only hashed scripts and stylesheets", async () => {
    const page = await call("GET", "/view/demo/note.md");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.headers.get("content-security-policy")).toContain("/static/build/js/");
    const links = linked(page.text);
    expect(links.map((l) => l.replace(/-[0-9a-f]{12}/, "").replace("/static/build/", "/static/"))).toEqual(
      expect.arrayContaining(["/static/style.css", "/static/hljs/github.css", "/static/hljs/github-dark.css", "/static/js/recover.js", "/static/js/boot.js", "/static/js/main.js"]),
    );
    for (const link of links) expect(link).toMatch(/^\/static\/build\/.*-[0-9a-f]{12}\.(js|css)$/);
  });

  it("answers each hashed file as immutable, with its type", async () => {
    const links = linked((await call("GET", "/view/demo/note.md")).text);
    for (const link of links) {
      const res = await call("GET", link);
      expect(res.status, link).toBe(200);
      expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("content-type")).toMatch(link.endsWith(".js") ? /javascript/ : /text\/css/);
      expect(res.text.length).toBeGreaterThan(100);
    }
  });

  it("points the bundle at the hashed diagram library", async () => {
    const main = linked((await call("GET", "/view/demo/note.md")).text).find((l) => l.includes("/js/main-"));
    const text = (await call("GET", main)).text;
    const lib = text.match(/\/static\/build\/js\/vendor\/mermaid-[0-9a-f]{12}\.min\.js/)?.[0];
    expect(lib).toBeTruthy();
    expect(text).not.toContain("/static/js/vendor/mermaid.min.js");
    const res = await call("GET", lib);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("still serves the unhashed paths, uncached", async () => {
    for (const path of ["/static/js/main.js", "/static/js/doc.js", "/static/style.css", "/static/js/vendor/mermaid.min.js", "/static/favicon.svg"]) {
      const res = await call("GET", path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
    }
  });

  it("does not hand out a hashed-looking name that was never built", async () => {
    expect((await call("GET", "/static/build/js/main-000000000000.js")).status).toBe(404);
  });
});

function linked(html) {
  return [...html.matchAll(/(?:src|href)="(\/static\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
}

async function call(method, pathname) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`${HOST}${pathname}`, { method }), OPEN, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, text: await response.text() };
}
