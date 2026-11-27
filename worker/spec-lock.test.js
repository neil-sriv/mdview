import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

// The spec lock is in-memory on the one store object, and the R2 work it guards
// runs in the worker. A holder that never calls release (its request was
// cancelled) used to leave every later save queued. The next acquire takes the
// lock once the holder's deadline passes, and the abandoned release does not
// drop that new hold.
function store() {
  return env.STORE.get(env.STORE.idFromName("store"));
}

describe("spec lock", () => {
  let generation = null;

  afterEach(async () => {
    if (generation != null) await store().releaseSpecLock(generation);
    generation = null;
  });

  it("lets the next save take the lock when the holder never releases", async () => {
    const first = await store().acquireSpecLock(40);
    const started = Date.now();
    generation = await store().acquireSpecLock(30_000);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(30);
    expect(waited).toBeLessThan(5_000);
    expect(generation).not.toBe(first);

    // The abandoned holder checking in late must not unlock the new holder.
    await store().releaseSpecLock(first);
    let took = false;
    const third = store().acquireSpecLock(30_000).then((next) => {
      took = true;
      return next;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(took).toBe(false);
    await store().releaseSpecLock(generation);
    generation = await third;
    expect(took).toBe(true);
  });
});
