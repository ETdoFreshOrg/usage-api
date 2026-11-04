/**
 * Passive quota: CLIProxyAPI keeps the rate-limit headers from the latest real
 * request on each account (`quota.signals` / `quota.observed_at` in its
 * auth-files listing). Anthropic and OpenAI put the account's current usage in
 * those headers, so they give exact, seconds-old numbers without calling the
 * usage endpoints at all. Only the fields the headers actually carry are taken
 * from here; everything else (Fable/Design windows, Spark, reset credits, plan
 * label for Claude) still comes from the slower active check.
 */

import { classifyCodexWindows } from "./codex-windows.js";

export interface PassiveObservation {
  /** ISO time of the request whose headers produced these signals. */
  observedAt: string;
  signals: Record<string, string>;
}

export interface PassiveClaudeWindow { utilization: number; resets_at: string | null }
/** five_hour is null when the headers carry no 5h window (account has none, or headers omit it). */
export interface PassiveClaude { five_hour: PassiveClaudeWindow | null; seven_day: PassiveClaudeWindow }

export interface PassiveCodexWindow { used_percent: number; resets_at: string | null; window_minutes: number }
export interface PassiveCodex {
  plan_type: string | null;
  five_hour: PassiveCodexWindow | null;
  one_day: PassiveCodexWindow | null;
  seven_day: PassiveCodexWindow | null;
  credits_balance: string | null;
}

/** CPA's `quota` block → observation, or null when it holds no signals yet. */
export function readObservation(quota: unknown): PassiveObservation | null {
  const q = quota as { observed_at?: unknown; signals?: unknown } | null | undefined;
  if (!q || typeof q.observed_at !== "string" || !q.signals || typeof q.signals !== "object") return null;
  const at = Date.parse(q.observed_at);
  if (!Number.isFinite(at)) return null;
  const signals: Record<string, string> = {};
  for (const [k, v] of Object.entries(q.signals as Record<string, unknown>))
    if (typeof v === "string") signals[k.toLowerCase()] = v;
  return Object.keys(signals).length ? { observedAt: new Date(at).toISOString(), signals } : null;
}

const num = (v: string | undefined) => {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const epochIso = (v: string | undefined) => {
  const n = num(v);
  return n != null && n > 0 ? new Date(n * 1000).toISOString() : null;
};

export function parsePassiveClaude(o: PassiveObservation): PassiveClaude | null {
  const s = o.signals;
  // Header utilization is a fraction (0.57); the usage API and clients use percent.
  const window = (slot: "5h" | "7d"): PassiveClaudeWindow | null => {
    const fraction = num(s[`anthropic-ratelimit-unified-${slot}-utilization`]);
    return fraction == null ? null : {
      utilization: Math.round(fraction * 10000) / 100,
      resets_at: epochIso(s[`anthropic-ratelimit-unified-${slot}-reset`]),
    };
  };
  const sevenDay = window("7d");
  return sevenDay ? { five_hour: window("5h"), seven_day: sevenDay } : null;
}

// OpenAI names the limit a request counted against in x-codex-active-limit. "premium" is the
// account's Codex limit; other values are feature limits with their own windows (an image
// request reports "imagegen_premium" and a 24-hour image quota). Their headers say nothing
// about the account's Codex limit, so they are not read as it. A missing header is taken as the
// Codex limit, as before the header existed.
const CODEX_ACCOUNT_LIMIT = "premium";
const warnedLimits = new Set<string>();

/** Name of the feature limit these Codex headers describe, or null when they describe the account's own limit. */
export function codexFeatureLimit(o: PassiveObservation): string | null {
  const limit = (o.signals["x-codex-active-limit"] ?? "").trim().toLowerCase();
  if (!limit || limit === CODEX_ACCOUNT_LIMIT) return null;
  if (!warnedLimits.has(limit) && !limit.startsWith("imagegen")) {
    warnedLimits.add(limit);
    console.warn(`passive Codex headers for limit "${limit}" are not the account limit; using the active check instead`);
  }
  return limit;
}

/** Whether an observation's headers describe the account's own limits (and so can be shown). */
export function describesAccountLimits(family: string, o: PassiveObservation | null): boolean {
  return !!o && (family !== "codex" || codexFeatureLimit(o) === null);
}

export function parsePassiveCodex(o: PassiveObservation): PassiveCodex | null {
  const s = o.signals;
  if (codexFeatureLimit(o) !== null) return null;
  const windows: PassiveCodexWindow[] = [];
  for (const slot of ["primary", "secondary"]) {
    const used = num(s[`x-codex-${slot}-used-percent`]);
    const minutes = num(s[`x-codex-${slot}-window-minutes`]);
    // An unused slot is reported as 0% over a 0-minute window (promax has no 5-hour limit).
    if (used == null || minutes == null || minutes <= 0) continue;
    let resets = epochIso(s[`x-codex-${slot}-reset-at`]);
    const after = num(s[`x-codex-${slot}-reset-after-seconds`]);
    if (!resets && after != null) resets = new Date(Date.parse(o.observedAt) + after * 1000).toISOString();
    windows.push({ used_percent: used, resets_at: resets, window_minutes: minutes });
  }
  if (windows.length === 0) return null;
  const unlimited = (s["x-codex-credits-unlimited"] ?? "").toLowerCase() === "true";
  return {
    plan_type: s["x-codex-plan-type"] || null,
    // Classified by window length, not header slot: promax reports its weekly window as "primary".
    // Same cut-offs as the active check.
    ...classifyCodexWindows(windows),
    credits_balance: unlimited ? "unlimited" : s["x-codex-credits-balance"] || null,
  };
}

// Usage only rises within a window, but the headers round down (0.59 while the usage API
// says 60). While both describe the same window (resets within an hour of each other),
// keep the higher number so passive data never reads a point below the older check.
const sameWindow = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && Math.abs(Date.parse(a) - Date.parse(b)) < 3_600_000;
function atLeast<T extends { resets_at: string | null }>(passive: T, active: any, key: keyof T): T {
  const prior = active?.[key as string];
  return typeof prior === "number" && sameWindow(passive.resets_at, active?.resets_at) && prior > (passive[key] as number)
    ? { ...passive, [key]: prior } : passive;
}

/**
 * Overlay a passive observation on the last active result. Returns null (use
 * the active data as-is) when the observation is missing, older than the
 * active check, unparseable, or describes a window that has since reset.
 */
export function mergePassive(family: string, active: any, activeAt: string | null,
  observation: PassiveObservation | null, now = Date.now()): any | null {
  if (!observation) return null;
  if (activeAt && Date.parse(observation.observedAt) <= Date.parse(activeAt)) return null;
  // A window that reset after the request was observed makes its numbers wrong; wait for an active check.
  const rolled = (...resets: Array<string | null | undefined>) => resets.some(r => r != null && Date.parse(r) <= now);
  if (family === "claude") {
    const p = parsePassiveClaude(observation);
    if (!p || rolled(p.seven_day.resets_at)) return null;
    // Headers without a 5h window (e.g. once the weekly limit is hit) keep the active check's one.
    // A 5h window that has since reset is dropped by enrichClaude, not re-checked upstream.
    const fiveHour = p.five_hour ? atLeast(p.five_hour, active?.five_hour, "utilization") : active?.five_hour ?? null;
    return { ...(active ?? {}), five_hour: fiveHour, seven_day: atLeast(p.seven_day, active?.seven_day, "utilization") };
  }
  if (family !== "codex") return null;
  const p = parsePassiveCodex(observation);
  if (!p || rolled(p.five_hour?.resets_at, p.one_day?.resets_at, p.seven_day?.resets_at)) return null;
  const fiveHour = p.five_hour && atLeast(p.five_hour, active?.five_hour, "used_percent");
  const oneDay = p.one_day && atLeast(p.one_day, active?.one_day, "used_percent");
  const sevenDay = p.seven_day && atLeast(p.seven_day, active?.seven_day, "used_percent");
  return {
    ...(active ?? {}),
    plan_type: p.plan_type ?? active?.plan_type ?? null,
    five_hour: fiveHour,
    one_day: oneDay,
    seven_day: sevenDay,
    primary: fiveHour,
    secondary: sevenDay,
    additional: active?.additional ?? [],
    credits_balance: p.credits_balance ?? active?.credits_balance ?? null,
  };
}
