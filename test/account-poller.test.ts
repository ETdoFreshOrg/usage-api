import assert from "node:assert/strict";
import test from "node:test";
import { AccountPoller } from "../src/account-poller.js";
import { RateLimitError } from "../src/cache.js";

const T0 = Date.parse("2026-11-03T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function make(results: Array<unknown | Error>, family = "claude") {
  let now = T0;
  const calls: number[] = [];
  const passive: Array<[unknown, Date]> = [];
  const poller = new AccountPoller("claude", family, async () => {
    calls.push(now);
    const r = results.shift();
    if (r instanceof Error) throw r;
    return r;
  }, { onPassive: (d, at) => passive.push([d, at]) }, () => now);
  const next = () => Date.parse(poller.snapshot().nextFetchAt);
  return { poller, calls, passive, next, set: (ms: number) => { now = ms; } };
}
const week = (pct: number, reset: number) => ({ seven_day: { utilization: pct, resets_at: iso(reset) } });
const obs = (at: number, fraction: number, reset: number) => ({ observedAt: iso(at), signals: {
  "anthropic-ratelimit-unified-7d-utilization": String(fraction), "anthropic-ratelimit-unified-7d-reset": String(reset / 1000) } });

test("idle accounts are checked every 30 min, busy ones every 60 min", async () => {
  const resetFar = T0 + 5 * 86_400_000;
  const p = make([week(10, resetFar), week(10, resetFar)]);
  await p.poller.tick();
  assert.equal(p.next() - T0, 30 * 60_000);
  p.poller.observe(obs(T0 + 1000, 0.2, resetFar));
  assert.equal(p.next() - T0, 60 * 60_000);
  p.poller.stop();
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
  assert.equal(p.next() - T0, 30 * 60_000, "ignored headers keep the idle cadence");
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

test("a known reset pulls the next check to just after it", async () => {
  const reset = T0 + 10 * 60_000;
  const p = make([week(90, reset)]);
  await p.poller.tick();
  assert.equal(p.next() - reset, 90_000);
  p.poller.stop();
});

test("429 backs off 15 min doubling, honors a longer Retry-After, and keeps the backoff until a success", async () => {
  const p = make([new RateLimitError(252), new RateLimitError(0), new RateLimitError(7200), week(1, T0 + 86_400_000)]);
  await p.poller.tick();
  assert.equal(p.next() - T0, 900_000);
  // A passive observation must not pull the check back inside the backoff.
  p.poller.observe(obs(T0 + 1000, 0.1, T0 + 86_400_000));
  assert.equal(p.next() - T0, 900_000);
  await p.poller.tick();
  assert.equal(p.next() - T0, 1_800_000);
  await p.poller.tick();
  assert.equal(p.next() - T0, 7_201_000);
  await p.poller.tick();
  assert.equal(p.poller.snapshot().error, null);
  assert.equal(p.next() - T0, 60 * 60_000);
  p.poller.stop();
});

test("a restart with recent seeded data waits for the normal cadence instead of checking at once", () => {
  const p = make([]);
  p.poller.seed(week(5, T0 + 86_400_000), iso(T0 - 10 * 60_000));
  p.poller.start();
  assert.equal(p.next() - T0, 20 * 60_000);
  assert.equal(p.poller.snapshot().dataSource, "active");
  p.poller.stop();
});

test("a Claude 5-hour reset does not trigger an extra active check; Codex's still does", async () => {
  const resetFar = T0 + 5 * 86_400_000;
  const fiveSoon = T0 + 10 * 60_000;
  const withFive = { ...week(10, resetFar), five_hour: { utilization: 50, resets_at: iso(fiveSoon) } };
  const claude = make([withFive]);
  await claude.poller.tick();
  assert.equal(claude.next() - T0, 30 * 60_000);
  claude.poller.stop();
  const codex = make([{ seven_day: { used_percent: 10, resets_at: iso(resetFar) },
    five_hour: { used_percent: 50, resets_at: iso(fiveSoon) }, additional: [] }], "codex");
  await codex.poller.tick();
  assert.equal(codex.next() - T0, 10 * 60_000 + 90_000);
  codex.poller.stop();
});
