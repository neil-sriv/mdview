/**
 * Cloudflare Access in front of the Worker, checked again here.
 *
 * The JWT is Cf-Access-Jwt-Assertion, signed by ${TEAM_DOMAIN}/cdn-cgi/access/certs,
 * audience POLICY_AUD. email in HUMAN_EMAILS is a human. A service token whose
 * common_name is in AGENT_TOKEN_IDS is an agent, named by X-Mdview-Author.
 * BACKUP_TOKEN_ID may only read specs. ADMIN_TOKEN_ID is the one-time import.
 * Anything else verified is 403.
 *
 * No token at all: a browser (or curl -I) is redirected to Access; an API
 * client gets 401. `/internal/` is an API. A token that does not verify is
 * 401, redirect or not.
 *
 * AUTH_MODE=open (no Access in front, until Neil's IdP is ready): a request
 * with no Authorization header is 401. Set ALLOW_ANONYMOUS_HUMAN=1 to treat
 * that request as the first HUMAN_EMAILS entry instead (never on a public
 * host: anyone who can send the page's Origin can then write as that human).
 * `/internal/` stays 401 either way. `Authorization: Bearer <key>` picks the role:
 * ADMIN_KEY is admin, BACKUP_KEY is backup, AGENT_KEY is an agent named by
 * X-Mdview-Agent (or X-Mdview-Author). Any other bearer is 401.
 */

const CERT_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_CHARS = 8192;

let cache = { domain: "", expires: 0, keys: new Map() };

/** Tests swap keys. Production keeps the certs for ten minutes. */
export function resetAccessCache() {
  cache = { domain: "", expires: 0, keys: new Map() };
}

export async function identify(request, env) {
  if (authMode(env) === "open") return identifyOpen(request, env);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return { response: unsigned(request, env) };
  try {
    const claims = await verifyAccessJwt(token, env);
    const identity = mapIdentity(claims, request, env);
    if (!identity) return { response: reject(request, 403, "This identity can't do that.") };
    return { identity };
  } catch {
    return { response: reject(request, 401, "Sign in.") };
  }
}

export function authMode(env) {
  const mode = String(env.AUTH_MODE ?? "").trim().toLowerCase();
  if (!mode || mode === "access") return "access";
  if (mode === "open") return "open";
  throw new Error(`AUTH_MODE must be access or open, not ${mode}`);
}

async function identifyOpen(request, env) {
  const pathname = new URL(request.url).pathname;
  const auth = request.headers.get("Authorization");
  if (!auth) {
    if (pathname.startsWith("/internal/")) return { response: reject(request, 401, "That API needs a key.") };
    // Off unless a deploy opts in. specs.neilsriv.tech must not: curl with
    // Origin set to the public host was enough to write as the human.
    if (String(env.ALLOW_ANONYMOUS_HUMAN ?? "") !== "1") return { response: reject(request, 401, "Sign in.") };
    const author = split(env.HUMAN_EMAILS)[0];
    if (!author) return { response: reject(request, 403, "This identity can't do that.") };
    return { identity: { kind: "human", author, session: null } };
  }
  const match = /^Bearer\s+(\S+)\s*$/i.exec(auth);
  const key = match ? match[1] : "";
  if (key && (await sameSecret(key, env.ADMIN_KEY))) return { identity: { kind: "admin", author: "admin", session: null } };
  if (key && (await sameSecret(key, env.BACKUP_KEY))) return { identity: { kind: "backup", author: "backup", session: null } };
  if (key && (await sameSecret(key, env.AGENT_KEY))) {
    const author = request.headers.get("X-Mdview-Agent") ?? request.headers.get("X-Mdview-Author") ?? "";
    return { identity: { kind: "agent", author, session: null } };
  }
  return { response: reject(request, 401, "Bad key.") };
}

/** Compares SHA-256 digests so the check takes the same time for any length. */
async function sameSecret(given, expected) {
  const want = String(expected ?? "");
  if (!want) return false;
  const encode = (value) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([encode(given), encode(want)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function verifyAccessJwt(token, env) {
  if (token.length > MAX_TOKEN_CHARS) throw new Error("size");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("shape");
  const header = json(parts[0]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("alg");
  const key = await publicKey(header.kid, env);
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(parts[2]), signed);
  if (!ok) throw new Error("sig");
  const claims = json(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("exp");
  if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("nbf");
  const team = teamDomain(env);
  if (claims.iss !== team) throw new Error("iss");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!env.POLICY_AUD || !aud.includes(env.POLICY_AUD)) throw new Error("aud");
  return claims;
}

function mapIdentity(claims, request, env) {
  const email = typeof claims.email === "string" ? claims.email.trim() : "";
  const emails = new Set([...split(env.HUMAN_EMAILS)].map((item) => item.toLowerCase()));
  if (email && emails.has(email.toLowerCase())) return { kind: "human", author: email, session: null };
  const name = typeof claims.common_name === "string" ? claims.common_name.trim() : "";
  if (!name) return null;
  if (name === String(env.BACKUP_TOKEN_ID ?? "").trim()) return { kind: "backup", author: name, session: null };
  if (name === String(env.ADMIN_TOKEN_ID ?? "").trim()) return { kind: "admin", author: name, session: null };
  if (new Set(split(env.AGENT_TOKEN_IDS)).has(name)) {
    return { kind: "agent", author: request.headers.get("X-Mdview-Author") ?? "", session: null };
  }
  return null;
}

function unsigned(request, env) {
  const url = new URL(request.url);
  const api = url.pathname.startsWith("/api/") || url.pathname.startsWith("/internal/");
  const browser = (request.headers.get("accept") ?? "").includes("text/html");
  // curl -I is HEAD. Access answers that with the login redirect; an API
  // client that simply omitted the token gets 401.
  if (request.method === "HEAD" || browser || !api) return redirectToAccess(request, env);
  return reject(request, 401, "Sign in.");
}

function redirectToAccess(request, env) {
  const url = new URL(request.url);
  const login = new URL(`${teamDomain(env)}/cdn-cgi/access/login/${url.host}${url.pathname}`);
  if (env.POLICY_AUD) login.searchParams.set("kid", env.POLICY_AUD);
  login.searchParams.set("redirect_url", `${url.origin}${url.pathname}${url.search}`);
  return new Response(null, { status: 302, headers: { Location: login.toString(), "Cache-Control": "no-store" } });
}

function reject(request, status, message) {
  const pathname = new URL(request.url).pathname;
  const api = pathname.startsWith("/api/") || pathname.startsWith("/internal/");
  if (!api) return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

function teamDomain(env) {
  return String(env.TEAM_DOMAIN ?? "").replace(/\/$/, "");
}

function split(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function publicKey(kid, env) {
  const keys = await certs(env);
  const jwk = keys.get(kid);
  if (!jwk) throw new Error("kid");
  return crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

async function certs(env) {
  const domain = teamDomain(env);
  if (cache.domain === domain && cache.expires > Date.now() && cache.keys.size) return cache.keys;
  const res = await fetch(`${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("certs");
  const body = await res.json();
  const keys = new Map();
  for (const key of body.keys ?? []) if (key?.kid) keys.set(key.kid, key);
  if (!keys.size) throw new Error("certs");
  cache = { domain, expires: Date.now() + CERT_TTL_MS, keys };
  return keys;
}

function json(segment) {
  return JSON.parse(new TextDecoder().decode(bytes(segment)));
}

function bytes(segment) {
  const pad = segment.length % 4 === 0 ? "" : "=".repeat(4 - (segment.length % 4));
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
