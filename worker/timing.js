/**
 * Per-request costs for the Server-Timing header on /api/ answers: time spent
 * waiting on R2 and on the comment store, and whether the rendered doc came
 * from the render cache. Calls that overlap each count in full.
 */
export class Timing {
  #spans = new Map();
  #notes = [];

  /** `target` with every method call timed under `name`. */
  wrap(target, name) {
    return new Proxy(target, {
      get: (t, key) => {
        const value = t[key];
        if (typeof value !== "function") return value;
        return (...args) => this.time(name, () => value.apply(t, args));
      },
    });
  }

  async time(name, fn) {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      const span = this.#spans.get(name) ?? { ms: 0, n: 0 };
      span.ms += Date.now() - start;
      span.n += 1;
      this.#spans.set(name, span);
    }
  }

  note(name, desc) {
    this.#notes.push(`${name};desc="${desc}"`);
  }

  header(totalMs) {
    const parts = [...this.#spans].map(([name, { ms, n }]) => `${name};dur=${ms};desc="${n} call${n === 1 ? "" : "s"}"`);
    return [...parts, ...this.#notes, `total;dur=${totalMs}`].join(", ");
  }
}
