/**
 * Claude/Codex account poller. Two sources feed each account:
 *   - passive: the rate-limit headers CLIProxyAPI saw on the account's latest real
 *     request (see passive.ts), read from CPA's account listing every 15 s at no
 *     upstream cost;
 *   - active: a usage-endpoint check (one upstream GET per check through CPA's
 *     api-call; see providers/cliproxy.ts).
 *
 * Active checks aim to keep shown data about a minute old:
 *   - an idle account (no new passive headers) is checked every
 *     ACCOUNT_IDLE_SECONDS (60 s; per provider with ACCOUNT_IDLE_SECONDS_CLAUDE /
 *     _CODEX), counted from whichever is newer: the last check or the passive
 *     data being shown. Idle checks also catch use outside CPA (claude.ai, direct
 *     CLI logins);
 *   - an account in use through CPA, whose headers keep its weekly/5-hour numbers
 *     seconds old, is still checked every ACCOUNT_BUSY_SECONDS (5 min) for the
 *     fields headers lack (Fable/Design, Spark, reset credits);
 *   - runs once just after a known window reset;
 *   - checks from all accounts are spaced at least ACCOUNT_SPACING_SECONDS (5 s)
 *     apart (UpstreamSpacer), so the accounts spread across the minute instead of
 *     bursting, and stay spread because each cadence counts from its real start.
 *
 * Backoff:
 *   - 429: the account's own cadence doubles (60 s -> 2 min -> 4 min ..., at most
 *     ACCOUNT_429_MAX_INTERVAL_SECONDS, 15 min) and the next check waits that long,
 *     doubling again for consecutive 429s up to ACCOUNT_429_MAX_SECONDS (1 h), and
 *     never sooner than Retry-After. After ACCOUNT_429_RELAX_SECONDS (30 min) of
 *     clean checks the cadence halves again, back down to the normal 60 s, so each
 *     account settles on the fastest pace its provider tolerates.
 *   - other errors: retry after ACCOUNT_ERROR_BASE_SECONDS (60 s) doubling, at most
 *     ACCOUNT_ERROR_MAX_SECONDS (15 min); the first success restores the normal pace.
 */
import { RateLimitError, Staleness } from "./cache.js";
import { describesAccountLimits, mergePassive, PassiveObservation } from "./passive.js";

const envSec = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const IDLE_SEC = envSec("ACCOUNT_IDLE_SECONDS", 60);
export const ACCOUNT_TIMING = {
  /** Normal check interval per provider family; other families use the plain default. */
  idleSec: { default: IDLE_SEC, claude: envSec("ACCOUNT_IDLE_SECONDS_CLAUDE", IDLE_SEC),
    codex: envSec("ACCOUNT_IDLE_SECONDS_CODEX", IDLE_SEC) } as Record<string, number>,
  busySec: envSec("ACCOUNT_BUSY_SECONDS", 5 * 60),
  /** Passive data younger than this means the account is in use through CPA (reported in intervalSec). */
  passiveFreshSec: envSec("ACCOUNT_PASSIVE_FRESH_SECONDS", 2 * 60),
  /** Delay after a known reset before checking, so the provider has rolled the window. */
  afterResetSec: envSec("ACCOUNT_AFTER_RESET_SECONDS", 90),
  /** Minimum gap between any two accounts' upstream checks. */
  spacingSec: envSec("ACCOUNT_SPACING_SECONDS", 5),
  rateLimitMaxIntervalSec: envSec("ACCOUNT_429_MAX_INTERVAL_SECONDS", 15 * 60),
  rateLimitMaxSec: envSec("ACCOUNT_429_MAX_SECONDS", 3600),
  rateLimitRelaxSec: envSec("ACCOUNT_429_RELAX_SECONDS", 30 * 60),
  errorBaseSec: envSec("ACCOUNT_ERROR_BASE_SECONDS", 60),
  errorMaxSec: envSec("ACCOUNT_ERROR_MAX_SECONDS", 15 * 60),
  // Shown data is about a minute old when checks succeed, so 3 min means checks are being
  // missed or slowed (429 backoff, errors); 30 min means the numbers can no longer be trusted.
  littleStaleSec: envSec("ACCOUNT_STALE_LITTLE_SECONDS", 3 * 60),
  staleSec: envSec("ACCOUNT_STALE_SECONDS", 30 * 60),
};

export const idleSecFor = (family: string) => ACCOUNT_TIMING.idleSec[family] ?? ACCOUNT_TIMING.idleSec.default;

/**
 * Shared across accounts: each wait() resolves at least gapMs after the previous caller's
 * start, so checks that fall due together go out one at a time.
 */
export class UpstreamSpacer {
  private nextFree = 0;
  constructor(
    private readonly gapMs = ACCOUNT_TIMING.spacingSec * 1000,
    private readonly now: () => number = Date.now,
    private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {}

  async wait(): Promise<void> {
    const start = Math.max(this.now(), this.nextFree);
    this.nextFree = start + this.gapMs;
    const delay = start - this.now();
    if (delay > 0) await this.sleep(delay);
  }
}

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
  /** Current normal check interval: idle/busy cadence, raised while recovering from 429s. */
  intervalSec: number;
  nextFetchAt: string;
  /** 429-driven slowdown: the idle cadence is multiplied by 2^this (0 = normal pace). */
  rateLimitLevel: number;
  /** Time of the latest 429 from the provider, if any since start. */
  lastRateLimitedAt: string | null;
}

export interface AccountPollerHooks {
  /** Each successful active check (raw active data). */
  onActive?: (data: unknown, at: Date) => void;
  /** Each new passive observation that changed the shown data (merged data). */
  onPassive?: (data: unknown, at: Date) => void;
  /** Shared spacing between accounts' upstream checks; awaited before each check starts. */
  spacer?: UpstreamSpacer;
}

export function accountStaleness(fetchedAt: string | null, now = Date.now()): Staleness {
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (!Number.isFinite(at)) return "stale";
  const age = (now - at) / 1000;
  return age >= ACCOUNT_TIMING.staleSec ? "stale" : age >= ACCOUNT_TIMING.littleStaleSec ? "little_stale" : "fresh";
}

/**
 * Reset times present in Claude/Codex data (ISO strings), for the after-reset check. Claude's
 * 5-hour window is left out: once it resets the account simply has no open session (null), which
 * needs no upstream check, and it rolls several times a day.
 */
function resetTimes(data: any, family: string): number[] {
  if (!data || typeof data !== "object") return [];
  const windows = [data.seven_day, family === "claude" ? null : data.five_hour, data.one_day, data.seven_day_fable, data.seven_day_design,
    ...(Array.isArray(data.additional) ? data.additional.flatMap((a: any) => [a?.five_hour, a?.one_day, a?.seven_day]) : [])];
  return windows.map(w => Date.parse(w?.resets_at ?? "")).filter(Number.isFinite);
}

export class AccountPoller {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Set by stop() (unlike `stopped`, which also covers "not started yet", e.g. a direct tick()). */
  private halted = false;
  private running = false;
  /** Consecutive 429s since the last success. */
  private rateLimited = 0;
  /** Slowdown level from 429s; decays one step per rateLimitRelaxSec of clean checks. */
  private rateLimitLevel = 0;
  private lastRateLimitAt = 0;
  private relaxedAt = 0;
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
    this.halted = false;
    const seeded = this.activeFetchedAt ? Date.parse(this.activeFetchedAt) : NaN;
    const due = Number.isFinite(seeded) ? seeded + this.baseIntervalSec() * 1000 : 0;
    this.schedule(Math.max(this.now() + initialDelaySec * 1000, due));
  }

  stop() {
    this.stopped = true;
    this.halted = true;
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

  // Only headers that describe the account's own limits stand in for active checks; a run of
  // image requests (whose headers carry the image quota) leaves the normal cadence in place.
  private passiveFresh(): boolean {
    if (!describesAccountLimits(this.family, this.observation)) return false;
    const at = Date.parse(this.observation!.observedAt);
    return Number.isFinite(at) && this.now() - at < ACCOUNT_TIMING.passiveFreshSec * 1000;
  }

  /** Idle cadence for this account: its provider's interval, slowed by any 429 level. */
  private idleIntervalSec() {
    const base = idleSecFor(this.family);
    if (this.rateLimitLevel === 0) return base;
    return Math.max(base, Math.min(ACCOUNT_TIMING.rateLimitMaxIntervalSec, base * 2 ** this.rateLimitLevel));
  }

  private busyIntervalSec() {
    return Math.max(ACCOUNT_TIMING.busySec, this.idleIntervalSec());
  }

  private baseIntervalSec() {
    return this.passiveFresh() ? this.busyIntervalSec() : this.idleIntervalSec();
  }

  private shown(): { data: unknown; at: string | null; source: "passive" | "active" | null } {
    const merged = mergePassive(this.family, this.active, this.activeFetchedAt, this.observation, this.now());
    if (merged) return { data: merged, at: this.observation!.observedAt, source: "passive" };
    return { data: this.active, at: this.activeFetchedAt, source: this.active == null ? null : "active" };
  }

  /**
   * Next active check: the idle interval after the newer of the last attempt and the passive data
   * being shown (so an account in use is not re-checked while its headers keep arriving), but no
   * later than the busy interval after the last attempt; just after a known reset if sooner.
   */
  private dueAt(): number {
    if (this.backoffUntil > this.now()) return this.backoffUntil;
    const last = this.lastAttemptAt ? Date.parse(this.lastAttemptAt) : NaN;
    if (!Number.isFinite(last)) return this.nextAt.getTime();
    const idleMs = this.idleIntervalSec() * 1000;
    let due = last + idleMs;
    const shown = this.shown();
    const shownAt = shown.source === "passive" && shown.at ? Date.parse(shown.at) : NaN;
    if (Number.isFinite(shownAt))
      due = Math.min(last + this.busyIntervalSec() * 1000, Math.max(due, shownAt + idleMs));
    for (const reset of resetTimes(shown.data, this.family))
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
    // Wait for this account's turn first, and count the cadence from when the check really
    // starts, so accounts that queued behind each other stay spread out afterwards.
    await this.hooks.spacer?.wait();
    // stop() while waiting (account removed): skip the check.
    if (this.halted) { this.running = false; return; }
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
      // Step the 429 slowdown back down after a clean stretch, one level at a time.
      if (this.rateLimitLevel > 0
        && this.now() - Math.max(this.lastRateLimitAt, this.relaxedAt) >= ACCOUNT_TIMING.rateLimitRelaxSec * 1000) {
        this.rateLimitLevel--;
        this.relaxedAt = this.now();
        console.log(`[${this.name}] no 429 for ${ACCOUNT_TIMING.rateLimitRelaxSec}s; check interval now ${this.idleIntervalSec()}s`);
      }
      this.hooks.onActive?.(data, at);
    } catch (err) {
      if (err instanceof RateLimitError) {
        this.rateLimited++;
        this.lastRateLimitAt = this.now();
        if (this.idleIntervalSec() < ACCOUNT_TIMING.rateLimitMaxIntervalSec) this.rateLimitLevel++;
        // Wait at least the new (slower) interval, doubling for consecutive 429s, never sooner
        // than Retry-After.
        const backoff = Math.min(ACCOUNT_TIMING.rateLimitMaxSec, this.idleIntervalSec() * 2 ** (this.rateLimited - 1));
        const delay = Math.max(backoff, err.retryAfterSec + 1);
        this.backoffUntil = this.now() + delay * 1000;
        this.error = `rate-limited (retry in ${Math.round(delay)}s)`;
        console.warn(`[${this.name}] ${this.error}; Retry-After ${err.retryAfterSec || "none"}; check interval now ${this.idleIntervalSec()}s`);
      } else {
        this.failures++;
        const delay = Math.min(ACCOUNT_TIMING.errorMaxSec, ACCOUNT_TIMING.errorBaseSec * 2 ** (this.failures - 1));
        this.backoffUntil = this.now() + delay * 1000;
        this.error = err instanceof Error ? err.message : String(err);
        console.error(`[${this.name}] fetch failed (retry in ${Math.round(delay)}s):`, this.error);
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
      rateLimitLevel: this.rateLimitLevel,
      lastRateLimitedAt: this.lastRateLimitAt ? new Date(this.lastRateLimitAt).toISOString() : null,
    };
  }
}
