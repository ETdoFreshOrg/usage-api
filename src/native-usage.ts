// Runtime catalog metadata. Studio's Antigravity records have no producer feeding this API.
// Keep this outside proxy analytics and account snapshots so it never contributes to totals.
import { open } from "node:fs/promises";
import { constants } from "node:fs";

const nativeUsage = {
  antigravity: {
    display_name: "Google Gemini",
    model_name: "Gemini 4 Neon",
    model_id: "gemini-4-neon-high",
    telemetry: "unavailable",
  },
} as const;

const periods = ["five_hour", "weekly"] as const;
const staleAfterMs = 30 * 60 * 1000;
type Period = typeof periods[number];
type Window = { period: Period; remaining_percent: number | null; resets_at: string | null };
type Snapshot = { group: string; observed_at: string; windows: Window[] };
type Quota = Omit<Snapshot, "windows"> & {
  source: "antigravity_manual";
  account: "antigravity-personal";
  status: "fresh" | "stale";
  windows: (Window & { used_percent: number | null; expired: boolean })[];
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function instant(value: unknown): string | null {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function parseAntigravityQuota(value: unknown, now = Date.now()): Snapshot | null {
  const snapshot = object(value);
  const group = snapshot.group;
  const observed_at = instant(snapshot.observed_at);
  if (snapshot.model_id !== nativeUsage.antigravity.model_id ||
      snapshot.account !== "antigravity-personal" ||
      typeof group !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 &-]{0,47}$/.test(group) ||
      observed_at === null || Date.parse(observed_at) > now) return null;
  const supplied = object(snapshot.windows);
  const windows = periods.flatMap(period => {
    const window = object(supplied[period]);
    const remaining = window.remaining_percent;
    const remaining_percent = typeof remaining === "number" && remaining >= 0 && remaining <= 100
      ? Number(remaining.toFixed(6)) : null;
    const resets_at = instant(window.resets_at);
    return remaining_percent === null && resets_at === null ? [] : [{ period, remaining_percent, resets_at }];
  });
  return windows.length ? { group, observed_at, windows } : null;
}

export async function readAntigravityQuota(file: string | undefined): Promise<Snapshot | null> {
  if (!file) return null;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8192) return null;
      const data = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      return bytesRead > 8192 ? null : parseAntigravityQuota(JSON.parse(data.toString("utf8", 0, bytesRead)));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function nativeUsageAt(snapshot: Snapshot | null = null, now = Date.now()):
  { antigravity: typeof nativeUsage.antigravity & { quota?: Quota } } {
  if (!snapshot) return nativeUsage;
  const windows = snapshot.windows.map(window => {
    const expired = window.resets_at !== null && Date.parse(window.resets_at) <= now;
    const remaining_percent = expired ? null : window.remaining_percent;
    return { ...window, remaining_percent, used_percent: remaining_percent === null ? null :
      Number((100 - remaining_percent).toFixed(6)), expired };
  });
  return { antigravity: { ...nativeUsage.antigravity, quota: {
    source: "antigravity_manual",
    account: "antigravity-personal",
    group: snapshot.group,
    observed_at: snapshot.observed_at,
    status: now - Date.parse(snapshot.observed_at) >= staleAfterMs ? "stale" : "fresh",
    windows,
  } } };
}
