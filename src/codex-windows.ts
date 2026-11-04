/**
 * Codex window slots. OpenAI's primary/secondary header and response slots are positional, so
 * every Codex window is filed by its length instead: five_hour, one_day (24-hour windows, as
 * OpenAI already uses for its image quota) or seven_day. Shared by the active usage check
 * (providers/codex.ts) and the passive CPA header path (passive.ts).
 */

export interface CodexWindow {
  used_percent: number;
  resets_at: string | null;
  window_minutes: number;
}

export type CodexWindowSlot = "five_hour" | "one_day" | "seven_day";
export const CODEX_WINDOW_SLOTS: readonly CodexWindowSlot[] = ["five_hour", "one_day", "seven_day"];
export type CodexWindows = Record<CodexWindowSlot, CodexWindow | null>;

/**
 * Which semantic slot a window of this length belongs to, or null when the length is unknown.
 * The cut-offs sit between the lengths OpenAI uses (5 h, 24 h, 7 d) so modest server-side
 * changes still land in the right slot: up to 12 h is a session window, up to 3 days a daily
 * one, anything longer the weekly one.
 */
export function codexWindowSlot(windowMinutes: number | null | undefined): CodexWindowSlot | null {
  if (typeof windowMinutes !== "number" || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  if (windowMinutes <= 12 * 60) return "five_hour";
  if (windowMinutes <= 3 * 24 * 60) return "one_day";
  return "seven_day";
}

/** Sort windows into five_hour / one_day / seven_day by length; windows of unknown length are dropped. */
export function classifyCodexWindows(windows: Array<CodexWindow | null | undefined>): CodexWindows {
  const out: CodexWindows = { five_hour: null, one_day: null, seven_day: null };
  for (const w of windows) {
    const slot = w ? codexWindowSlot(w.window_minutes) : null;
    if (w && slot && !out[slot]) out[slot] = w;
  }
  return out;
}

/**
 * Re-sort already-parsed windows by length. Results saved before the 24-hour slot existed hold a
 * 1440-minute window under five_hour; this moves it to one_day. A window whose length is unknown
 * stays where it was.
 */
export function reclassifyCodexWindows(data: Partial<Record<CodexWindowSlot, CodexWindow | null>> | null | undefined): CodexWindows {
  const out: CodexWindows = { five_hour: null, one_day: null, seven_day: null };
  for (const from of CODEX_WINDOW_SLOTS) {
    const w = data?.[from];
    if (!w) continue;
    const slot = codexWindowSlot(w.window_minutes) ?? from;
    if (!out[slot]) out[slot] = w;
  }
  return out;
}
