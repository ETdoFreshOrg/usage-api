import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HistoryStore, extractUsageMetrics } from "../src/history.ts";

test("extractUsageMetrics finds percentage windows without token details", () => {
  const metrics = extractUsageMetrics({
    five_hour: { utilization: 12.5, expected_percent: 20, resets_at: "2026-01-01T05:00:00.000Z" },
    monthly: { used_percent: 34.25, expected_percent: 50.5, resets_at: "2026-02-01T00:00:00.000Z" },
    ignored: { current: 10, limit: 20 },
  });

  assert.deepEqual(metrics, [
    { metric: "five_hour", value: 12.5, expectedValue: 20, resetIso: "2026-01-01T05:00:00.000Z" },
    { metric: "monthly", value: 34.25, expectedValue: 50.5, resetIso: "2026-02-01T00:00:00.000Z" },
  ]);
});

test("HistoryStore includes expected usage percentage in fine and aggregate graph points", () => {
  const store = new HistoryStore({ retentionMs: 8 * 24 * 60 * 60 * 1000 });

  store.recordProvider("codex", { primary: { used_percent: 10, expected_percent: 20, resets_at: null } }, new Date("2026-01-02T01:10:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 20, expected_percent: 30, resets_at: null } }, new Date("2026-01-02T01:40:00.000Z"));

  const fine = store.toSeries("fine");
  const hourly = store.toSeries("hourly");

  assert.deepEqual(fine.series[0].points.map((p) => p.expectedValue), [20, 30]);
  assert.deepEqual(hourly.series[0].points.map((p) => p.expectedValue), [25]);
});

test("HistoryStore retains only the last eight days of refresh samples", () => {
  const store = new HistoryStore({ retentionMs: 8 * 24 * 60 * 60 * 1000 });

  store.recordProvider("claude", { five_hour: { utilization: 1, resets_at: null } }, new Date("2026-01-01T00:00:00.000Z"));
  store.recordProvider("claude", { five_hour: { utilization: 2, resets_at: null } }, new Date("2026-01-08T23:59:00.000Z"));
  store.recordProvider("claude", { five_hour: { utilization: 3, resets_at: null } }, new Date("2026-01-09T00:01:00.000Z"));

  const fine = store.toSeries("fine");

  assert.equal(fine.series.length, 1);
  assert.deepEqual(fine.series[0].points.map((p) => p.value), [2, 3]);
});

test("HistoryStore keeps usage samples indefinitely by default", () => {
  const store = new HistoryStore();

  store.recordProvider("claude", { five_hour: { utilization: 1, resets_at: null } }, new Date("2020-01-01T00:00:00.000Z"));
  store.recordProvider("claude", { five_hour: { utilization: 2, resets_at: null } }, new Date("2026-01-09T00:01:00.000Z"));

  const fine = store.toSeries("fine");

  assert.equal(fine.retentionDays, null);
  assert.deepEqual(fine.series[0].points.map((p) => p.value), [1, 2]);
});

test("HistoryStore backfills missing expected percentages by walking backward with wraparound", () => {
  const store = new HistoryStore({ retentionMs: Infinity });

  store.recordProvider("codex", { primary: { used_percent: 10, resets_at: null } }, new Date("2026-01-02T00:00:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 20, resets_at: null } }, new Date("2026-01-02T01:00:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 30, expected_percent: 20, resets_at: null } }, new Date("2026-01-02T02:00:00.000Z"));

  const fine = store.toSeries("fine");

  assert.deepEqual(fine.series[0].points.map((p) => p.expectedValue), [80, 0, 20]);
});

test("HistoryStore backfill wraps below zero back to 100 percent", () => {
  const store = new HistoryStore({ retentionMs: Infinity });

  store.recordProvider("codex", { primary: { used_percent: 10, resets_at: null } }, new Date("2026-01-01T20:00:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 20, expected_percent: 20, resets_at: null } }, new Date("2026-01-02T02:00:00.000Z"));

  const fine = store.toSeries("fine");

  assert.deepEqual(fine.series[0].points.map((p) => p.expectedValue), [100, 20]);
});

test("HistoryStore backfills a 24-hour series over a 24-hour window", () => {
  const store = new HistoryStore({ retentionMs: Infinity });

  store.recordProvider("codex", { one_day: { used_percent: 5, resets_at: null } }, new Date("2026-01-02T00:00:00.000Z"));
  store.recordProvider("codex", { one_day: { used_percent: 6, expected_percent: 50, resets_at: null } }, new Date("2026-01-02T06:00:00.000Z"));

  const fine = store.toSeries("fine");

  assert.equal(fine.series[0].metric, "one_day");
  assert.deepEqual(fine.series[0].points.map((p) => p.expectedValue), [25, 50]);
});

test("HistoryStore can aggregate percentage samples into hourly and daily graph points", () => {
  const store = new HistoryStore({ retentionMs: 8 * 24 * 60 * 60 * 1000 });

  store.recordProvider("codex", { primary: { used_percent: 10, resets_at: null } }, new Date("2026-01-02T01:10:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 20, resets_at: null } }, new Date("2026-01-02T01:40:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 40, resets_at: null } }, new Date("2026-01-02T05:00:00.000Z"));

  const hourly = store.toSeries("hourly");
  const daily = store.toSeries("daily");

  assert.deepEqual(hourly.series[0].points.map((p) => ({ t: p.t, value: p.value, min: p.min, max: p.max, count: p.count })), [
    { t: "2026-01-02T01:00:00.000Z", value: 15, min: 10, max: 20, count: 2 },
    { t: "2026-01-02T05:00:00.000Z", value: 40, min: 40, max: 40, count: 1 },
  ]);
  assert.deepEqual(daily.series[0].points.map((p) => ({ t: p.t, value: p.value, min: p.min, max: p.max, count: p.count })), [
    { t: "2026-01-02T00:00:00.000Z", value: 23.333, min: 10, max: 40, count: 3 },
  ]);
});

test("HistoryStore load keeps good records when a line is corrupt", async () => {
  // An append interrupted mid-write leaves a truncated line behind. Before,
  // one such line threw during load and silently discarded every sample in
  // the file; a real history of 339k records was lost to three bad ones.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "usage-history-"));
  const filePath = path.join(dir, "usage-history.jsonl");
  const good = (iso: string, value: number) =>
    JSON.stringify({ ts: iso, provider: "codex", metrics: [{ metric: "primary", value, resetIso: null }] });

  await fs.writeFile(
    filePath,
    [
      good("2026-01-02T01:00:00.000Z", 10),
      '{"ts":"2026-01-02T01:30:00.000Z","provider":"codex","metrics":[{"metric":"prim',
      good("2026-01-02T02:00:00.000Z", 30),
    ].join("\n") + "\n",
    "utf8",
  );

  try {
    const store = new HistoryStore({ filePath, retentionMs: Infinity });
    await store.load();
    const points = store.toSeries("fine").series[0].points;
    assert.deepEqual(points.map((p) => p.value), [10, 30]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
