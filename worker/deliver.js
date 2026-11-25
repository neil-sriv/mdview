/**
 * Posts due outbox rows to the Route spec comments routine.
 *
 * Same request the Mac notifier sends: POST, `authorization: Bearer <key>`,
 * `content-type: application/json`, 15s timeout. A non-2xx or a network error
 * backs off 1, 2, 4, … 60 min. The body already carries `deliveryId`, so a
 * retry is the same post.
 */
import { backoffMs } from "./outbox.js";
import { storeStub } from "./store.js";

export async function deliverOutbox(env, { now = new Date(), fetcher = fetch } = {}) {
  const url = env.ROUTE_SPEC_COMMENTS_WEBHOOK_URL;
  if (!url) return { delivered: 0, failed: 0 };
  const stub = storeStub(env);
  const due = await stub.outboxDue(now.toISOString());
  let delivered = 0;
  let failed = 0;
  for (const row of due) {
    const ok = await post(env, url, row, fetcher);
    if (ok) {
      await stub.markDelivered([Number(row.id)], now.toISOString());
      delivered += 1;
    } else {
      const attempts = Number(row.attempts) + 1;
      const nextAt = new Date(now.getTime() + backoffMs(attempts)).toISOString();
      await stub.markFailed(Number(row.id), nextAt);
      failed += 1;
    }
  }
  return { delivered, failed };
}

async function post(env, url, row, fetcher) {
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.ROUTE_SPEC_COMMENTS_WEBHOOK_KEY ?? ""}`,
      },
      body: row.payload,
      signal: AbortSignal.timeout(15_000),
    });
    await res.arrayBuffer().catch(() => {});
    if (!res.ok) {
      console.error(JSON.stringify({ msg: "comment webhook failed", messageId: Number(row.messageId), status: res.status }));
      return false;
    }
    return true;
  } catch (err) {
    console.error(JSON.stringify({ msg: "comment webhook failed", messageId: Number(row.messageId), error: String(err?.message ?? err) }));
    return false;
  }
}
