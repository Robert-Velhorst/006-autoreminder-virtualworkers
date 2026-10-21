// Serial scenarios share accounts. Respect the real API window between tests.
export class ApiRateWindow {
  #resetAt = 0;

  observe(headers, now = Date.now()) {
    if (headers["x-ratelimit-limit"] !== "60") return;
    const resetAt = Number(headers["x-ratelimit-reset"]);
    if (!Number.isSafeInteger(resetAt) || resetAt <= now || resetAt > now + 60_500) return;
    this.#resetAt = Math.max(this.#resetAt, resetAt + 100);
  }

  waitMilliseconds(now = Date.now()) {
    return Math.max(0, this.#resetAt - now);
  }
}
