// Runtime catalog metadata. Studio's Antigravity records have no producer feeding this API.
// Keep this outside proxy analytics and account snapshots so it never contributes to totals.
import { open } from "node:fs/promises";
import { constants } from "node:fs";

const nativeUsage = {
  antigravity: {
    display_name: "Antigravity",
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
const groupNames = { gemini_models: "Gemini Models", claude_gpt_models: "Claude and GPT Models" } as const;
type ScreenshotGroup = {
  id: keyof typeof groupNames;
  label: (typeof groupNames)[keyof typeof groupNames];
  windows: (Window & { used_percent: number; expired: null })[];
};
type Screenshot = {
  source: "antigravity_screenshot";
  account: "antigravity-personal";
  plan: "Pro";
  observed_at: null;
  status: "unknown";
  groups: ScreenshotGroup[];
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

function percent(value: unknown): number | null {
  return typeof value === "number" && value >= 0 && value <= 100 ? Number(value.toFixed(6)) : null;
}

export function parseAntigravityScreenshot(value: unknown): Screenshot | null {
  const input = object(value);
  if (input.source !== "antigravity_screenshot" || input.account !== "antigravity-personal" ||
      input.plan !== "Pro") return null;
  const supplied = object(input.groups);
  const groups = (Object.keys(groupNames) as (keyof typeof groupNames)[]).flatMap(id => {
    const amounts = object(supplied[id]);
    const windows = periods.flatMap(period => {
      const remaining_percent = percent(amounts[period]);
      return remaining_percent === null ? [] : [{
        period, remaining_percent, used_percent: Number((100 - remaining_percent).toFixed(6)),
        resets_at: null, expired: null,
      }];
    });
    return windows.length ? [{ id, label: groupNames[id], windows }] : [];
  });
  return groups.length ? {
    source: "antigravity_screenshot", account: "antigravity-personal", plan: "Pro",
    observed_at: null, status: "unknown", groups,
  } : null;
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
    const remaining_percent = percent(window.remaining_percent);
    const resets_at = instant(window.resets_at);
    return remaining_percent === null && resets_at === null ? [] : [{ period, remaining_percent, resets_at }];
  });
  return windows.length ? { group, observed_at, windows } : null;
}

export async function readAntigravityQuota(file: string | undefined): Promise<Snapshot | Screenshot | null> {
  if (!file) return null;
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 8192) return null;
      const data = Buffer.alloc(8193);
      const { bytesRead } = await handle.read(data, 0, data.length, 0);
      if (bytesRead > 8192) return null;
      const input: unknown = JSON.parse(data.toString("utf8", 0, bytesRead));
      return parseAntigravityScreenshot(input) ?? parseAntigravityQuota(input);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function nativeUsageAt(snapshot: Snapshot | Screenshot | null = null, now = Date.now()):
  { antigravity: typeof nativeUsage.antigravity & { quota?: Quota; subscription?: Screenshot } } {
  if (!snapshot) return nativeUsage;
  if ("source" in snapshot) return { antigravity: { ...nativeUsage.antigravity, subscription: snapshot } };
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
