/**
 * A fake-clock wait during which the runtime stays alive. Moving the clock by hand (`clock += ms`) models a
 * suspended runtime: nothing of it runs meanwhile, so a lease holder stops renewing and its 30-second lease
 * lapses (用户 2026-09-28「30 秒有效 + 每 10 秒续约」). `leaseRenewingWait(ms)` moves the clock the same way but
 * runs each lease renewal that falls due on the way, at its own time, as a live runtime would.
 *
 * Only renewal timers run: the tests using this were written with every other timer skipped over by the jump
 * (a slow request that ends on its own), and their expected values depend on that. Outside the wait, every
 * timer still fires in real time as before.
 */
export function installLeaseRenewalTimers(clock: Readonly<{ now: () => number; set: (value: number) => void }>) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  type Handle = ReturnType<typeof setTimeout>;
  type Entry = { dueAt: number; renewal: boolean; order: number; run: () => void };
  const pending = new Map<Handle, Entry>();
  let order = 0;
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const handle: Handle = realSetTimeout(() => {
      pending.delete(handle);
      callback(...args);
    }, ms);
    // The lease module schedules nothing but its renewal.
    const renewal = /services\/refresh-runtime-state\.ts/.test(new Error().stack || "");
    pending.set(handle, {
      dueAt: clock.now() + Math.max(0, Number(ms) || 0), renewal, order: order++, run: () => callback(...args),
    });
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle?: Handle) => {
    if (handle != null) pending.delete(handle);
    realClearTimeout(handle);
  }) as typeof clearTimeout;
  return async function leaseRenewingWait(ms: number): Promise<void> {
    const target = clock.now() + ms;
    for (;;) {
      const [handle, next] = [...pending]
        .filter(([, entry]) => entry.renewal && entry.dueAt <= target)
        .sort(([, a], [, b]) => a.dueAt - b.dueAt || a.order - b.order)[0] ?? [];
      if (!handle || !next) break;
      pending.delete(handle);
      realClearTimeout(handle);
      clock.set(Math.max(clock.now(), next.dueAt));
      next.run();
      for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    clock.set(Math.max(clock.now(), target));
  };
}
