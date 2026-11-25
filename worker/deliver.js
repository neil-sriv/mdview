/**
 * Posts due outbox rows to the Route spec comments routine.
 *
 * The header is a guess: the Mac script that posts today is not in this
 * repo, so the key goes out as `Authorization: Bearer <key>`. The body is
 * the row's payload, which already includes deliveryId and link.
 * A non-2xx or a network error backs off (1, 2, 4, … 60 min). The same
 * deliveryId is sent on every retry.
 */
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
      await stub.markFailed([Number(row.id)], now.toISOString());
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
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.ROUTE_SPEC_COMMENTS_WEBHOOK_KEY ?? ""}`,
      },
      body: row.payload,
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
