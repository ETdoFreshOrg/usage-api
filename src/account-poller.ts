/**
 * Claude/Codex account poller. The main source of numbers is passive: the
 * rate-limit headers CLIProxyAPI saw on the account's latest real request
 * (see passive.ts), refreshed every account sync at no upstream cost. The
 * active usage-endpoint check is a slow backup that:
 *   - runs every ACCOUNT_BUSY_SECONDS (60 min) while passive data is fresh,
 *     which is mainly for fields headers lack (Fable/Design, Spark, credits);
 *   - runs every ACCOUNT_IDLE_SECONDS (30 min) while passive data is stale or
 *     absent, to catch usage outside CPA (claude.ai, direct CLI logins);
 *   - runs once just after a known window reset;
 *   - backs off on 429 (15 min doubling to 6 h, never below Retry-After) and
 *     only returns to the normal cadence after a success.
 */
import { RateLimitError, Staleness } from "./cache.js";
import { mergePassive, PassiveObservation } from "./passive.js";

const envSec = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
export const ACCOUNT_TIMING = {
  busySec: envSec("ACCOUNT_BUSY_SECONDS", 3600),
  idleSec: envSec("ACCOUNT_IDLE_SECONDS", 1800),
  /** Passive data younger than this means the account is in use through CPA. */
  passiveFreshSec: envSec("ACCOUNT_PASSIVE_FRESH_SECONDS", 1800),
  /** Delay after a known reset before checking, so the provider has rolled the window. */
  afterResetSec: envSec("ACCOUNT_AFTER_RESET_SECONDS", 90),
  rateLimitBaseSec: envSec("ACCOUNT_429_BASE_SECONDS", 900),
  rateLimitMaxSec: envSec("ACCOUNT_429_MAX_SECONDS", 6 * 3600),
  errorBaseSec: envSec("ACCOUNT_ERROR_BASE_SECONDS", 120),
  // Idle accounts are checked every 30 min, so data up to that age is current.
  littleStaleSec: envSec("ACCOUNT_STALE_LITTLE_SECONDS", 45 * 60),
  staleSec: envSec("ACCOUNT_STALE_SECONDS", 3 * 3600),
};

export interface AccountSnapshot {
  data: unknown;
  /** When the numbers shown were true: the passive observation time or the active check time. */
  fetchedAt: string | null;
  /** "passive" = CPA request headers, "active" = usage-endpoint check, null = no data yet. */
  dataSource: "passive" | "active" | null;
  /** Time of the latest passive observation, whether or not it is in use. */
  observedAt: string | null;
  /** Time of the last successful active check. */
  activeFetchedAt: string | null;
  lastAttemptAt: string | null;
  ageSec: number | null;
  staleness: Staleness;
  error: string | null;
  intervalSec: number;
  nextFetchAt: string;
}

export interface AccountPollerHooks {
  /** Each successful active check (raw active data). */
  onActive?: (data: unknown, at: Date) => void;
  /** Each new passive observation that changed the shown data (merged data). */
  onPassive?: (data: unknown, at: Date) => void;
}

export function accountStaleness(fetchedAt: string | null, now = Date.now()): Staleness {
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (!Number.isFinite(at)) return "stale";
  const age = (now - at) / 1000;
  return age >= ACCOUNT_TIMING.staleSec ? "stale" : age >= ACCOUNT_TIMING.littleStaleSec ? "little_stale" : "fresh";
}

/** Reset times present in Claude/Codex data (ISO strings), for the after-reset check. */
function resetTimes(data: any): number[] {
  if (!data || typeof data !== "object") return [];
  const windows = [data.seven_day, data.five_hour, data.seven_day_fable, data.seven_day_design,
    ...(Array.isArray(data.additional) ? data.additional.flatMap((a: any) => [a?.five_hour, a?.seven_day]) : [])];
  return windows.map(w => Date.parse(w?.resets_at ?? "")).filter(Number.isFinite);
}

export class AccountPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;
  private rateLimited = 0;
  private failures = 0;
  private nextAt = new Date();
  private backoffUntil = 0;
  private lastShownKey = "";

  active: unknown = null;
  activeFetchedAt: string | null = null;
  lastAttemptAt: string | null = null;
  error: string | null = null;
  observation: PassiveObservation | null = null;

  constructor(
    public readonly name: string,
    public readonly family: string,
    private readonly fetcher: () => Promise<unknown>,
    private readonly hooks: AccountPollerHooks = {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Restore the last active result so a restart does not re-check every account at once. */
  seed(data: unknown, fetchedAt: string) {
    if (this.active == null) { this.active = data; this.activeFetchedAt = fetchedAt; }
  }

  /** First check: due when the seeded data would have been re-checked anyway, else after `initialDelaySec`. */
  start(initialDelaySec = 0) {
    this.stopped = false;
    const seeded = this.activeFetchedAt ? Date.parse(this.activeFetchedAt) : NaN;
    const due = Number.isFinite(seeded) ? seeded + this.baseIntervalSec() * 1000 : 0;
    this.schedule(Math.max(this.now() + initialDelaySec * 1000, due));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** New passive observation from the account sync; may pull the next active check earlier. */
  observe(observation: PassiveObservation | null) {
    // CPA keeps signals in memory only; after its restart keep the last observation rather than forget it.
    if (!observation || observation.observedAt === this.observation?.observedAt) return;
    this.observation = observation;
    const shown = this.shown();
    if (shown.source === "passive" && shown.at) {
      const key = JSON.stringify(shown.data);
      if (key !== this.lastShownKey) {
        this.lastShownKey = key;
        this.hooks.onPassive?.(shown.data, new Date(shown.at));
      }
    }
    if (!this.running) this.schedule(this.dueAt());
  }

  private passiveFresh(): boolean {
    const at = this.observation ? Date.parse(this.observation.observedAt) : NaN;
    return Number.isFinite(at) && this.now() - at < ACCOUNT_TIMING.passiveFreshSec * 1000;
  }

  private baseIntervalSec() {
    return this.passiveFresh() ? ACCOUNT_TIMING.busySec : ACCOUNT_TIMING.idleSec;
  }

  private shown(): { data: unknown; at: string | null; source: "passive" | "active" | null } {
    const merged = mergePassive(this.family, this.active, this.activeFetchedAt, this.observation, this.now());
    if (merged) return { data: merged, at: this.observation!.observedAt, source: "passive" };
    return { data: this.active, at: this.activeFetchedAt, source: this.active == null ? null : "active" };
  }

  /** Next active check: the normal cadence from the last attempt, or just after a reset if sooner. */
  private dueAt(): number {
    if (this.backoffUntil > this.now()) return this.backoffUntil;
    const last = this.lastAttemptAt ? Date.parse(this.lastAttemptAt) : NaN;
    if (!Number.isFinite(last)) return this.nextAt.getTime();
    let due = last + this.baseIntervalSec() * 1000;
    for (const reset of resetTimes(this.shown().data))
      if (reset > last) due = Math.min(due, reset + ACCOUNT_TIMING.afterResetSec * 1000);
    return Math.max(due, this.now());
  }

  private schedule(at: number) {
    this.nextAt = new Date(at);
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(0, at - this.now()));
  }

  async tick() {
    this.running = true;
    this.lastAttemptAt = new Date(this.now()).toISOString();
    try {
      const data = await this.fetcher();
      const at = new Date(this.now());
      this.active = data;
      this.activeFetchedAt = at.toISOString();
      this.error = null;
      this.rateLimited = 0;
      this.failures = 0;
      this.backoffUntil = 0;
      this.lastShownKey = "";
      this.hooks.onActive?.(data, at);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.rateLimited++;
        // Never sooner than Retry-After, and never straight back to the normal pace.
        const backoff = Math.min(ACCOUNT_TIMING.rateLimitMaxSec,
          ACCOUNT_TIMING.rateLimitBaseSec * 2 ** (this.rateLimited - 1));
        const delay = Math.max(backoff, err.retryAfterSec + 1);
        this.backoffUntil = this.now() + delay * 1000;
        this.error = `rate-limited (retry in ${Math.round(delay)}s)`;
        console.warn(`[${this.name}] ${this.error}`);
      } else {
        this.failures++;
        const delay = Math.min(this.baseIntervalSec(), ACCOUNT_TIMING.errorBaseSec * 2 ** (this.failures - 1));
        this.backoffUntil = this.now() + delay * 1000;
        this.error = err instanceof Error ? err.message : String(err);
        console.error(`[${this.name}] fetch failed:`, this.error);
      }
    } finally {
      this.running = false;
      this.schedule(this.dueAt());
    }
  }

  snapshot(): AccountSnapshot {
    const shown = this.shown();
    const at = shown.at ? Date.parse(shown.at) : NaN;
    return {
      data: shown.data,
      fetchedAt: shown.at,
      dataSource: shown.source,
      observedAt: this.observation?.observedAt ?? null,
      activeFetchedAt: this.activeFetchedAt,
      lastAttemptAt: this.lastAttemptAt,
      ageSec: Number.isFinite(at) ? Math.round((this.now() - at) / 1000) : null,
      staleness: accountStaleness(shown.at, this.now()),
      error: this.error,
      intervalSec: this.baseIntervalSec(),
      nextFetchAt: this.nextAt.toISOString(),
    };
  }
}
