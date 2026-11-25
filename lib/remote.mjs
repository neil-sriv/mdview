/**
 * HTTP to the Worker. Tokens come from the environment, never from the repo.
 * The admin service token is a different pair from the agent token; when the
 * admin pair is unset, the agent pair is used so one token can drive a test.
 */
export function tokenPair(env, role) {
  if (role === "admin") {
    return {
      id: env.MDVIEW_ADMIN_ACCESS_CLIENT_ID || env.MDVIEW_ACCESS_CLIENT_ID || "",
      secret: env.MDVIEW_ADMIN_ACCESS_CLIENT_SECRET || env.MDVIEW_ACCESS_CLIENT_SECRET || "",
    };
  }
  return {
    id: env.MDVIEW_ACCESS_CLIENT_ID || "",
    secret: env.MDVIEW_ACCESS_CLIENT_SECRET || "",
  };
}

export function accessHeaders(env, role, { json = false } = {}) {
  const token = tokenPair(env, role);
  const headers = {};
  if (role !== "admin") headers["X-Mdview-Author"] = env.MDVIEW_AUTHOR || "agent";
  if (token.id) headers["CF-Access-Client-Id"] = token.id;
  if (token.secret) headers["CF-Access-Client-Secret"] = token.secret;
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

export class RemoteError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

export async function workerFetch(env, method, pathname, { body, role = "agent", fetchImpl = globalThis.fetch } = {}) {
  if (!env.MDVIEW_URL) throw new RemoteError("Set MDVIEW_URL.", 0);
  let res;
  try {
    res = await fetchImpl(new URL(pathname, env.MDVIEW_URL), {
      method,
      headers: accessHeaders(env, role, { json: body !== undefined }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new RemoteError(`Could not reach ${env.MDVIEW_URL}: ${err.message}`);
  }
  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  if (!res.ok) {
    const message = payload && typeof payload === "object" ? payload.message || payload.error : payload;
    throw new RemoteError(message || `HTTP ${res.status}`, res.status, payload);
  }
  return { status: res.status, payload, text };
}
