import assert from "node:assert/strict";
import test from "node:test";
import { ACCOUNT_TIMING, AccountPoller, accountStaleness, UpstreamSpacer } from "../src/account-poller.js";
import { RateLimitError } from "../src/cache.js";

const T0 = Date.parse("2026-11-03T12:00:00Z");
// Shipped per-provider cadences; the tests below run Claude accounts at 60 s like Codex.
const SHIPPED_IDLE = { ...ACCOUNT_TIMING.idleSec };
ACCOUNT_TIMING.idleSec.claude = 60;
const iso = (ms: number) => new Date(ms).toISOString();

function make(results: Array<unknown | Error>, family = "claude", spacer?: UpstreamSpacer, clock?: { now: number }) {
  const c = clock ?? { now: T0 };
  const calls: number[] = [];
  const passive: Array<[unknown, Date]> = [];
  const poller = new AccountPoller("claude", family, async () => {
    calls.push(c.now);
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r;
  }, { onPassive: (d, at) => passive.push([d, at]), spacer }, () => c.now);
  const next = () => Date.parse(poller.snapshot().nextFetchAt);
  return { poller, calls, passive, next, set: (ms: number) => { c.now = ms; } };
}
const week = (pct: number, reset: number) => ({ seven_day: { utilization: pct, resets_at: iso(reset) } });
const obs = (at: number, fraction: number, reset: number) => ({ observedAt: iso(at), signals: {
  "anthropic-ratelimit-unified-7d-utilization": String(fraction), "anthropic-ratelimit-unified-7d-reset": String(reset / 1000) } });
/** Run `fn` with some ACCOUNT_TIMING idle intervals overridden (module constants are read from env once). */
async function withIdle(idle: Record<string, number>, fn: () => Promise<void> | void) {
  const saved = { ...ACCOUNT_TIMING.idleSec };
  Object.assign(ACCOUNT_TIMING.idleSec, idle);
  try { await fn(); } finally { Object.assign(ACCOUNT_TIMING.idleSec, saved); }
}

test("idle accounts are checked every 60 s; busy ones every 5 min while headers keep arriving", async () => {
  const resetFar = T0 + 5 * 86_400_000;
  const p = make([week(10, resetFar), week(10, resetFar)]);
  await p.poller.tick();
  assert.equal(p.next() - T0, 60_000);
  assert.equal(p.poller.snapshot().intervalSec, 60);
  // A new observation moves the idle clock to it...
  p.set(T0 + 30_000);
  p.poller.observe(obs(T0 + 30_000, 0.2, resetFar));
  assert.equal(p.next() - T0, 90_000);
  // ...and steady traffic pushes it out, but never past 5 min after the last check.
  for (let s = 60; s <= 290; s += 15) { p.set(T0 + s * 1000); p.poller.observe(obs(T0 + s * 1000, 0.2 + s / 100_000, resetFar)); }
  assert.equal(p.next() - T0, 5 * 60_000);
  assert.equal(p.poller.snapshot().intervalSec, 5 * 60);
  p.poller.stop();
});

test("an account that stops being used is re-checked 60 s after its last headers", async () => {
  const resetFar = T0 + 5 * 86_400_000;
  const p = make([week(10, resetFar)]);
  await p.poller.tick();
  p.set(T0 + 3 * 60_000);
  p.poller.observe(obs(T0 + 3 * 60_000, 0.3, resetFar));
  assert.equal(p.next() - T0, 4 * 60_000);
  p.poller.stop();
});

test("shipped cadence: Codex every 60 s, Claude every 120 s (Anthropic 429s some accounts at 60 s)", () => {
  assert.equal(SHIPPED_IDLE.codex, 60);
  assert.equal(SHIPPED_IDLE.claude, 120);
});

test("per-provider idle intervals apply to their own family only", async () => {
  await withIdle({ claude: 120 }, async () => {
    const claude = make([week(1, T0 + 86_400_000)]);
    await claude.poller.tick();
    assert.equal(claude.next() - T0, 120_000);
    claude.poller.stop();
    const codex = make([{ seven_day: { used_percent: 1, resets_at: iso(T0 + 86_400_000) }, additional: [] }], "codex");
    await codex.poller.tick();
    assert.equal(codex.next() - T0, 60_000);
    codex.poller.stop();
  });
});

test("image-request headers neither replace a Codex account's numbers nor slow its checks", async () => {
  const weekReset = T0 + 5 * 86_400_000;
  const weekly = { plan_type: "promax", seven_day: { used_percent: 100, resets_at: iso(weekReset), window_minutes: 10080 }, additional: [] };
  const p = make([weekly], "codex");
  await p.poller.tick();
  p.poller.observe({ observedAt: iso(T0 + 1000), signals: { "x-codex-active-limit": "imagegen_premium",
    "x-codex-primary-used-percent": "0", "x-codex-primary-window-minutes": "1440", "x-codex-primary-reset-at": String((T0 + 86_400_000) / 1000) } });
  const snap = p.poller.snapshot();
  assert.equal(snap.dataSource, "active");
  assert.equal((snap.data as any).seven_day.used_percent, 100);
  assert.equal(p.passive.length, 0);
  assert.equal(p.next() - T0, 60_000, "ignored headers keep the idle cadence");
  p.poller.stop();
});

test("fresh passive headers win over the older active check and report their source", async () => {
  const resetFar = T0 + 5 * 86_400_000;
  const p = make([week(10, resetFar)]);
  await p.poller.tick();
  p.set(T0 + 120_000);
  p.poller.observe(obs(T0 + 60_000, 0.42, resetFar));
  const s = p.poller.snapshot();
  assert.equal((s.data as any).seven_day.utilization, 42);
  assert.equal(s.dataSource, "passive");
  assert.equal(s.fetchedAt, iso(T0 + 60_000));
  assert.equal(s.ageSec, 60);
  assert.equal(p.passive.length, 1);
  // The same observation again is not re-recorded.
  p.poller.observe(obs(T0 + 60_000, 0.42, resetFar));
  assert.equal(p.passive.length, 1);
  p.poller.stop();
});

test("a known reset pulls a slower account's next check to just after it", async () => {
  await withIdle({ claude: 300 }, async () => {
    const reset = T0 + 2 * 60_000;
    const p = make([week(90, reset)]);
    await p.poller.tick();
    assert.equal(p.next() - reset, 90_000);
    p.poller.stop();
  });
});

test("429 doubles the account's cadence, honors a longer Retry-After, and holds until a success", async () => {
  const p = make([new RateLimitError(252), new RateLimitError(0), new RateLimitError(7200), week(1, T0 + 86_400_000)]);
  await p.poller.tick();
  // Cadence 60 -> 120 s, but Retry-After 252 s is longer.
  assert.equal(p.next() - T0, 253_000);
  assert.equal(p.poller.snapshot().rateLimitLevel, 1);
  assert.equal(p.poller.snapshot().lastRateLimitedAt, iso(T0));
  // A passive observation must not pull the check back inside the backoff.
  p.poller.observe(obs(T0 + 1000, 0.1, T0 + 86_400_000));
  assert.equal(p.next() - T0, 253_000);
  await p.poller.tick();
  // Cadence 240 s, doubled again for the second consecutive 429.
  assert.equal(p.next() - T0, 480_000);
  await p.poller.tick();
  assert.equal(p.next() - T0, 7_201_000);
  await p.poller.tick();
  assert.equal(p.poller.snapshot().error, null);
  // The 429s leave the account at 8 min until it has gone an hour without one.
  assert.equal(p.next() - T0, 480_000);
  assert.equal(p.poller.snapshot().intervalSec, 480);
  p.poller.stop();
});

test("after 429s the cadence steps back down to 60 s, one halving per clean hour", async () => {
  const ok = () => week(1, T0 + 5 * 86_400_000);
  const p = make([new RateLimitError(0), new RateLimitError(0), ok(), ok(), ok(), ok(), ok()]);
  await p.poller.tick();
  await p.poller.tick();
  assert.equal(p.poller.snapshot().rateLimitLevel, 2);
  p.set(T0 + 30 * 60_000);
  await p.poller.tick();
  assert.equal(p.next() - p.calls[2], 240_000, "too soon to relax");
  p.set(T0 + 60 * 60_000);
  await p.poller.tick();
  assert.equal(p.next() - p.calls[3], 120_000);
  p.set(T0 + 90 * 60_000);
  await p.poller.tick();
  assert.equal(p.next() - p.calls[4], 120_000, "each step needs its own clean hour");
  p.set(T0 + 120 * 60_000);
  await p.poller.tick();
  assert.equal(p.next() - p.calls[5], 60_000);
  assert.equal(p.poller.snapshot().rateLimitLevel, 0);
  p.poller.stop();
});

test("repeated 429s cap the cadence at 15 min and the wait at 1 h", async () => {
  const p = make(Array.from({ length: 6 }, () => new RateLimitError(0)));
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) { await p.poller.tick(); waits.push((p.next() - T0) / 1000); }
  assert.deepEqual(waits, [120, 480, 1920, 3600, 3600, 3600]);
  assert.equal(p.poller.snapshot().intervalSec, 900);
  p.poller.stop();
});

test("other errors retry after 60 s doubling to 15 min; a success restores the normal pace", async () => {
  const fail = () => new Error("CLIProxyAPI api-call HTTP 502");
  const p = make([fail(), fail(), fail(), fail(), fail(), fail(), week(1, T0 + 86_400_000)]);
  const waits: number[] = [];
  for (let i = 0; i < 6; i++) { await p.poller.tick(); waits.push((p.next() - T0) / 1000); }
  assert.deepEqual(waits, [60, 120, 240, 480, 900, 900]);
  await p.poller.tick();
  assert.equal(p.poller.snapshot().error, null);
  assert.equal(p.next() - T0, 60_000);
  p.poller.stop();
});

test("a restart with recent seeded data waits for the normal cadence instead of checking at once", () => {
  const p = make([]);
  p.poller.seed(week(5, T0 + 86_400_000), iso(T0 - 30_000));
  p.poller.start();
  assert.equal(p.next() - T0, 30_000);
  assert.equal(p.poller.snapshot().dataSource, "active");
  p.poller.stop();
});

test("a Claude 5-hour reset does not trigger an extra active check; Codex's still does", async () => {
  await withIdle({ claude: 300, codex: 300 }, async () => {
    const resetFar = T0 + 5 * 86_400_000;
    const fiveSoon = T0 + 2 * 60_000;
    const withFive = { ...week(10, resetFar), five_hour: { utilization: 50, resets_at: iso(fiveSoon) } };
    const claude = make([withFive]);
    await claude.poller.tick();
    assert.equal(claude.next() - T0, 5 * 60_000);
    claude.poller.stop();
    const codex = make([{ seven_day: { used_percent: 10, resets_at: iso(resetFar) },
      five_hour: { used_percent: 50, resets_at: iso(fiveSoon) }, additional: [] }], "codex");
    await codex.poller.tick();
    assert.equal(codex.next() - T0, 2 * 60_000 + 90_000);
    codex.poller.stop();
  });
});

test("the spacer lets checks out at least 5 s apart", async () => {
  const clock = { now: T0 };
  const spacer = new UpstreamSpacer(5000, () => clock.now, async ms => { clock.now += ms; });
  const starts: number[] = [];
  for (let i = 0; i < 3; i++) { await spacer.wait(); starts.push(clock.now - T0); }
  assert.deepEqual(starts, [0, 5000, 10_000]);
  clock.now += 60_000;
  await spacer.wait();
  assert.equal(clock.now - T0, 70_000, "no wait once the gap has passed");
});

test("accounts due together go out spaced and keep their spacing", async () => {
  const clock = { now: T0 };
  const spacer = new UpstreamSpacer(5000, () => clock.now, async ms => { clock.now += ms; });
  const resetFar = T0 + 5 * 86_400_000;
  const a = make([week(1, resetFar)], "claude", spacer, clock);
  const b = make([week(1, resetFar)], "claude", spacer, clock);
  await a.poller.tick();
  await b.poller.tick();
  assert.deepEqual([a.calls[0] - T0, b.calls[0] - T0], [0, 5000]);
  // Each cadence counts from its real start, so the next round is spaced too.
  assert.deepEqual([a.next() - T0, b.next() - T0], [60_000, 65_000]);
  a.poller.stop();
  b.poller.stop();
});

test("an account stopped while waiting for its turn skips the check", async () => {
  let release!: () => void;
  const spacer = { wait: () => new Promise<void>(r => { release = r; }) } as unknown as UpstreamSpacer;
  const p = make([week(1, T0 + 86_400_000)], "claude", spacer);
  const pending = p.poller.tick();
  p.poller.stop();
  release();
  await pending;
  assert.equal(p.calls.length, 0);
  assert.equal(p.poller.snapshot().lastAttemptAt, null);
});

test("account staleness: fresh under 3 min, a little stale under 30 min, then stale", () => {
  assert.equal(accountStaleness(iso(T0 - 179_000), T0), "fresh");
  assert.equal(accountStaleness(iso(T0 - 3 * 60_000), T0), "little_stale");
  assert.equal(accountStaleness(iso(T0 - 29 * 60_000), T0), "little_stale");
  assert.equal(accountStaleness(iso(T0 - 30 * 60_000), T0), "stale");
  assert.equal(accountStaleness(null, T0), "stale");
});
