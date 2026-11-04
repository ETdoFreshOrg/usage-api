import { promises as fs } from "node:fs";
import path from "node:path";

export type HistoryGranularity = "fine" | "hourly" | "daily";

export interface UsageMetric {
  metric: string;
  value: number;
  expectedValue?: number;
  resetIso?: string | null;
}

export interface HistoryRecord {
  ts: string;
  provider: string;
  metrics: UsageMetric[];
}

export interface SeriesPoint {
  t: string;
  value: number;
  expectedValue?: number;
  min: number;
  max: number;
  count: number;
}

export interface MetricSeries {
  provider: string;
  metric: string;
  points: SeriesPoint[];
}

export interface HistorySeriesResponse {
  granularity: HistoryGranularity;
  generatedAt: string;
  retentionDays: number | null;
  series: MetricSeries[];
}

interface HistoryStoreOptions {
  retentionMs?: number | null;
  filePath?: string | null;
}

interface BucketAccumulator {
  sum: number;
  expectedSum: number;
  expectedCount: number;
  min: number;
  max: number;
  count: number;
}

const DEFAULT_RETENTION_MS = Infinity;
const MAX_DEPTH = 8;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayPath(pathParts: string[]): string {
  return pathParts.join(" ");
}

export function extractUsageMetrics(data: unknown): UsageMetric[] {
  const metrics: UsageMetric[] = [];

  function visit(value: unknown, pathParts: string[], depth: number) {
    if (depth > MAX_DEPTH || value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, pathParts, depth + 1);
      return;
    }
    if (!isObject(value)) return;

    const rawPercent = value.used_percent ?? value.utilization;
    if (typeof rawPercent === "number" && Number.isFinite(rawPercent)) {
      const reset = value.resets_at;
      const expected = value.expected_percent;
      metrics.push({
        metric: displayPath(pathParts),
        value: Math.max(0, Math.min(100, rawPercent)),
        ...(typeof expected === "number" && Number.isFinite(expected) ? { expectedValue: Math.max(0, Math.min(100, expected)) } : {}),
        resetIso: typeof reset === "string" ? reset : null,
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if (child == null || typeof child !== "object") continue;
      if (Array.isArray(child)) {
        for (const item of child) {
          const name = isObject(item) && typeof item.name === "string" ? item.name : key;
          visit(item, [...pathParts, name], depth + 1);
        }
      } else {
        visit(child, [...pathParts, key], depth + 1);
      }
    }
  }

  visit(data, [], 0);
  return metrics.filter((metric) => metric.metric.length > 0);
}

export class HistoryStore {
  private records: HistoryRecord[] = [];
  private loaded = false;
  private appendQueue: Promise<void> = Promise.resolve();
  readonly retentionMs: number;
  readonly filePath: string | null;

  constructor(options: HistoryStoreOptions = {}) {
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
    this.filePath = options.filePath === undefined ? null : options.filePath;
  }

  get retentionDays() {
    if (!Number.isFinite(this.retentionMs)) return null;
    return Math.round(this.retentionMs / (24 * 60 * 60 * 1000));
  }

  async load() {
    if (this.loaded || !this.filePath) {
      this.loaded = true;
      return;
    }
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      // A single malformed line must not cost the whole history. An
      // interrupted append can leave one truncated record behind, and
      // parsing the file as an all-or-nothing batch turned those few bytes
      // into a total loss of every prior sample.
      let skipped = 0;
      const records: HistoryRecord[] = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line) continue;
        let record: HistoryRecord;
        try {
          record = JSON.parse(line) as HistoryRecord;
        } catch {
          skipped++;
          continue;
        }
        if (record?.metrics?.length) records.push(record);
      }
      this.records = records;
      if (skipped > 0) {
        console.warn(`usage history: skipped ${skipped} unparsable line(s) in ${this.filePath}, kept ${records.length}`);
      }
      this.prune();
    } catch (err: any) {
      if (err?.code !== "ENOENT") console.warn(`could not load usage history ${this.filePath}: ${err?.message ?? err}`);
    }
    this.loaded = true;
  }

  async flush() {
    await this.appendQueue;
  }

  recordProvider(provider: string, data: unknown, at = new Date()) {
    const metrics = extractUsageMetrics(data);
    if (metrics.length === 0) return;
    const record: HistoryRecord = { ts: at.toISOString(), provider, metrics };
    this.records.push(record);
    this.prune(at.getTime());
    if (this.filePath) {
      const line = `${JSON.stringify(record)}\n`;
      this.appendQueue = this.appendQueue
        .then(async () => {
          await fs.mkdir(path.dirname(this.filePath as string), { recursive: true });
          await fs.appendFile(this.filePath as string, line, "utf8");
        })
        .catch((err) => console.warn(`could not append usage history: ${err?.message ?? err}`));
    }
  }

  toSeries(granularity: HistoryGranularity): HistorySeriesResponse {
    const series = granularity === "fine" ? this.fineSeries() : this.aggregateSeries(granularity);
    return {
      granularity,
      generatedAt: new Date().toISOString(),
      retentionDays: this.retentionDays,
      series,
    };
  }

  private prune(nowMs = Date.now()) {
    if (!Number.isFinite(this.retentionMs)) return;
    const cutoff = nowMs - this.retentionMs;
    this.records = this.records.filter((record) => Date.parse(record.ts) >= cutoff);
  }

  private fineSeries(): MetricSeries[] {
    const grouped = new Map<string, MetricSeries>();
    for (const record of this.records) {
      for (const metric of record.metrics) {
        const key = `${record.provider}\u0000${metric.metric}`;
        let entry = grouped.get(key);
        if (!entry) {
          entry = { provider: record.provider, metric: metric.metric, points: [] };
          grouped.set(key, entry);
        }
        entry.points.push({
          t: record.ts,
          value: round(metric.value),
          ...(metric.expectedValue === undefined ? {} : { expectedValue: round(metric.expectedValue) }),
          min: round(metric.value),
          max: round(metric.value),
          count: 1,
        });
      }
    }
    return sortSeries([...grouped.values()].map((series) => ({
      ...series,
      points: backfillExpectedValues(series.provider, series.metric, series.points),
    })));
  }

  private aggregateSeries(granularity: Exclude<HistoryGranularity, "fine">): MetricSeries[] {
    const bucketMs = granularity === "hourly" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const grouped = new Map<string, { provider: string; metric: string; buckets: Map<string, BucketAccumulator> }>();

    for (const record of this.records) {
      const time = Date.parse(record.ts);
      if (!Number.isFinite(time)) continue;
      const bucketStart = new Date(Math.floor(time / bucketMs) * bucketMs).toISOString();
      for (const metric of record.metrics) {
        const key = `${record.provider}\u0000${metric.metric}`;
        let entry = grouped.get(key);
        if (!entry) {
          entry = { provider: record.provider, metric: metric.metric, buckets: new Map() };
          grouped.set(key, entry);
        }
        const bucket = entry.buckets.get(bucketStart) ?? { sum: 0, expectedSum: 0, expectedCount: 0, min: metric.value, max: metric.value, count: 0 };
        bucket.sum += metric.value;
        if (metric.expectedValue !== undefined) {
          bucket.expectedSum += metric.expectedValue;
          bucket.expectedCount++;
        }
        bucket.min = Math.min(bucket.min, metric.value);
        bucket.max = Math.max(bucket.max, metric.value);
        bucket.count++;
        entry.buckets.set(bucketStart, bucket);
      }
    }

    return sortSeries([...grouped.values()].map(({ provider, metric, buckets }) => ({
      provider,
      metric,
      points: backfillExpectedValues(provider, metric, [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, bucket]) => ({
          t,
          value: round(bucket.sum / bucket.count),
          ...(bucket.expectedCount === 0 ? {} : { expectedValue: round(bucket.expectedSum / bucket.expectedCount) }),
          min: round(bucket.min),
          max: round(bucket.max),
          count: bucket.count,
        }))),
    })));
  }
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function expectedWindowMs(provider: string, metric: string) {
  if (provider === "zai" && metric === "monthly") return 30 * 24 * 60 * 60 * 1000;
  if (metric.includes("seven_day") || metric.includes("secondary")) return 7 * 24 * 60 * 60 * 1000;
  if (metric.includes("one_day")) return 24 * 60 * 60 * 1000;
  return 5 * 60 * 60 * 1000;
}

function wrapExpectedPercent(value: number) {
  if (value >= 0) return value % 100;
  const wrapped = value % 100;
  return wrapped === 0 ? 100 : wrapped + 100;
}

function backfillExpectedValues(provider: string, metric: string, points: SeriesPoint[]) {
  const firstKnownIndex = points.findIndex((point) => point.expectedValue !== undefined);
  if (firstKnownIndex <= 0) return points;
  const windowMs = expectedWindowMs(provider, metric);
  const filled = points.map((point) => ({ ...point }));
  let nextKnown = filled[firstKnownIndex];
  for (let i = firstKnownIndex - 1; i >= 0; i--) {
    const currentTime = Date.parse(filled[i].t);
    const nextTime = Date.parse(nextKnown.t);
    const nextExpected = nextKnown.expectedValue;
    if (!Number.isFinite(currentTime) || !Number.isFinite(nextTime) || nextExpected === undefined) continue;
    const elapsedMs = nextTime - currentTime;
    const estimated = nextExpected - (elapsedMs / windowMs) * 100;
    filled[i].expectedValue = round(wrapExpectedPercent(estimated));
    nextKnown = filled[i];
  }
  return filled;
}

function sortSeries(series: MetricSeries[]) {
  return series.sort((a, b) => `${a.provider}:${a.metric}`.localeCompare(`${b.provider}:${b.metric}`));
}
