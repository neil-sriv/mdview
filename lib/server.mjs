/**
 * The Mac's HTTP server. It turns Node's request into a Fetch Request, calls
 * handle(), and writes the Response back. What the routes do lives in
 * lib/app.mjs, so the Worker can call the same function.
 */
import http from "node:http";
import { Readable } from "node:stream";
import { FsAssets } from "./assets.mjs";
import { handle } from "./app.mjs";
import { FsDocSource } from "./docs.mjs";
import { humanName } from "./store.mjs";

const PORT_ATTEMPTS = 20;

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/** A Node request as a Fetch Request. `signal` aborts when the client goes away. */
export function toRequest(req, signal) {
  const host = req.headers.host || "localhost";
  const url = `http://${host}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value != null) headers.append(key, value);
  }
  const method = req.method || "GET";
  const init = { method, headers, signal };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

/** Writes a Fetch Response onto a Node response, streaming the body. */
export async function writeNodeResponse(res, response) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  await new Promise((resolve) => {
    const stream = Readable.fromWeb(response.body);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    stream.on("error", done);
    res.on("error", done);
    res.on("close", done);
    res.on("finish", done);
    stream.pipe(res);
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Serves `root` on 127.0.0.1, starting at `port` and moving up past ports in
 * use. `initial` is the root-relative document that "/" opens. Without a
 * comment `store`, the viewer is read-only. The identity is always the human
 * at the keyboard; an agent identity is for the Worker.
 */
export async function startServer({ root, initial = "", port = 4545, store = null }) {
  const allowedHosts = new Set();
  const docs = new FsDocSource(root);
  const assets = new FsAssets();
  const server = http.createServer();
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt++) {
    const candidate = port + attempt;
    try {
      await listen(server, candidate);
      for (const host of ["127.0.0.1", "localhost", "[::1]"]) allowedHosts.add(`${host}:${candidate}`);
      server.on("request", (req, res) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.on("close", abort);
        const request = toRequest(req, controller.signal);
        handle(request, {
          docs,
          assets,
          store,
          initial,
          allowedHosts,
          identity: { kind: "human", author: humanName(), session: null },
        })
          .then((response) => writeNodeResponse(res, response))
          .catch((err) => {
            if (!res.headersSent) send(res, 500, String(err?.message ?? err));
            else res.end();
          })
          .finally(() => res.off("close", abort));
      });
      return { server, port: candidate, url: `http://127.0.0.1:${candidate}/` };
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No free port in ${port}-${port + PORT_ATTEMPTS - 1}`);
}
