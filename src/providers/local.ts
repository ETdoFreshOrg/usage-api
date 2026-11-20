/**
 * Local quota sources. usage-api makes no quota/usage request to Anthropic or ChatGPT, neither
 * directly nor through CLIProxyAPI's api-call (ET, 2026-11-20). Account numbers come only from
 * state that already exists on the network:
 *
 *   1. CLIProxyAPI's account list: the rate-limit headers of each account's latest real request
 *      (passive.ts). Seconds old while an account is in use; held in the proxy's memory only.
 *   2. CPA Manager's stored quota snapshots (POST /v0/management/quota-snapshots/query, a read of
 *      its database): the Claude weekly and 5-hour windows its auto-ping worker records every
 *      few minutes, and the Codex windows it saved from response headers. Survives a proxy restart.
 *   3. CPA Manager's auto-ping status (GET /v0/management/auto-ping): the weekly % of its latest
 *      quota check per account, and whether that check was rejected.
 *
 * This module reads 2 and 3 and turns them into one account's usage; account-poller.ts then lets
 * newer proxy headers (1) override it. Each window carries `as_of`, the time its number was
 * observed, and `source`. Whatever these sources do not hold is null: per-model weekly windows,
 * reset credits, the Claude plan label and subscription dates. Nothing is estimated.
 */

export interface ManagerAccount {
  /** usage-api connection id; echoed back by CPA Manager as row_key. */
  id: string;
  provider: string;
  email: string | null;
  fileName: string | null;
  authIndex: string;
  accountId: string | null;
}

export interface AutoPingAccount {
  status: string;
  checkedAt: string | null;
  weeklyPercent: number | null;
  /** HTTP status of a rejected quota check, when the status text reports one. */
  quotaHttpStatus: number | null;
}

export interface SnapshotWindow {
  provider_window_id?: string; window_kind?: string; model_scope_kind?: string; model_scope_key?: string | null;
  used_percent?: number | null; cycle_end_ms?: number | null; duration_seconds?: number | null;
  observed_at_ms?: number | null; plan_type?: string | null;
  field_sources?: { quota?: { observed_at_ms?: number | null } | null } | null;
}

export interface LocalState {
  autoPing: Map<string, AutoPingAccount>;
  snapshots: Map<string, SnapshotWindow[]>;
}

export type LocalSource = "manager_snapshot" | "auto_ping" | "proxy_headers";
export interface LocalWindow { resets_at: string | null; as_of: string; source: LocalSource }

/** The only CPA Manager requests this service makes. Both read stored state; neither starts a check. */
const READS = { autoPing: "auto-ping", snapshots: "quota-snapshots/query" } as const;

const iso = (ms: number) => new Date(ms).toISOString();
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseAutoPing(body: any): Map<string, AutoPingAccount> {
  const out = new Map<string, AutoPingAccount>();
  if (!Array.isArray(body?.accounts)) throw new Error("Invalid CPA Manager auto-ping answer");
  for (const a of body.accounts) {
    if (!a || typeof a.name !== "string" || a.enabled !== true) continue;
    const status = typeof a.status === "string" ? a.status : "";
    const http = /quota request returned HTTP (\d{3})/i.exec(status);
    out.set(a.name, {
      status,
      checkedAt: finite(a.checked_ms) && a.checked_ms > 0 ? iso(a.checked_ms) : null,
      // A rejected check leaves the previous number in place; it is not that check's result.
      weeklyPercent: !http && finite(a.weekly_percent) ? a.weekly_percent : null,
      quotaHttpStatus: http ? Number(http[1]) : null,
    });
  }
  return out;
}

export function parseSnapshots(body: any): Map<string, SnapshotWindow[]> {
  const out = new Map<string, SnapshotWindow[]>();
  if (!Array.isArray(body?.items)) throw new Error("Invalid CPA Manager quota-snapshot answer");
  for (const item of body.items)
    if (item && typeof item.row_key === "string" && Array.isArray(item.windows)) out.set(item.row_key, item.windows);
  return out;
}

export class ManagerClient {
  private cached: { at: number; key: string; state: LocalState } | null = null;
  private pending: Promise<LocalState> | null = null;
  constructor(private readonly url: string, private readonly key: string,
    private readonly fetcher: typeof fetch = fetch, private readonly cacheMs = 10_000,
    private readonly now: () => number = Date.now) {}

  private async read(path: (typeof READS)[keyof typeof READS], body?: unknown): Promise<any> {
    const response = await this.fetcher(`${this.url.replace(/\/$/, "")}/v0/management/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CPA Manager ${path} HTTP ${response.status}`);
    return response.json();
  }

  /** Auto-ping status and stored snapshots for these accounts; one pair of reads shared by all accounts. */
  async state(accounts: ManagerAccount[]): Promise<LocalState> {
    const key = accounts.map(a => a.id).sort().join("|");
    if (this.cached && this.cached.key === key && this.now() - this.cached.at < this.cacheMs) return this.cached.state;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      const [autoPing, snapshots] = await Promise.all([
        this.read(READS.autoPing).then(parseAutoPing),
        this.read(READS.snapshots, {
          accounts: accounts.map(a => ({ row_key: a.id, provider: a.provider, account: {
            account_snapshot: a.email ?? undefined, auth_label_snapshot: a.email ?? undefined,
            auth_file_snapshot: a.fileName ?? undefined, auth_provider_snapshot: a.provider,
            auth_account_id_snapshot: a.provider === "codex" ? a.accountId ?? undefined : undefined,
            auth_index: a.authIndex, source: a.fileName ?? undefined } })),
          now_ms: this.now(), include_inactive: true,
        }).then(parseSnapshots),
      ]);
      const state = { autoPing, snapshots };
      this.cached = { at: this.now(), key, state };
      return state;
    })().finally(() => { this.pending = null; });
    return this.pending;
  }
}

type Picked = { used: number; resetsAt: string | null; asOf: number; minutes: number | null; plan: string | null };

/** The newest stored snapshot of one window that is still open at `now`; a window that has reset is not shown. */
function pick(windows: SnapshotWindow[], match: (w: SnapshotWindow) => boolean, now: number): Picked | null {
  let best: Picked | null = null;
  for (const w of windows) {
    if (!match(w) || !finite(w.used_percent)) continue;
    const asOf = w.field_sources?.quota?.observed_at_ms ?? w.observed_at_ms;
    if (!finite(asOf) || asOf <= 0) continue;
    const end = finite(w.cycle_end_ms) && w.cycle_end_ms > 0 ? w.cycle_end_ms : null;
    if (end !== null && end <= now) continue;
    if (best && best.asOf >= asOf) continue;
    best = { used: w.used_percent, resetsAt: end === null ? null : iso(end), asOf,
      minutes: finite(w.duration_seconds) && w.duration_seconds > 0 ? Math.round(w.duration_seconds / 60) : null,
      plan: typeof w.plan_type === "string" && w.plan_type ? w.plan_type : null };
  }
  return best;
}

/** Weekly window: the stored snapshot, or auto-ping's weekly % when its check is newer (it reports no reset time). */
function weekly(snapshot: Picked | null, ping: AutoPingAccount | undefined): (Picked & { source: LocalSource }) | null {
  const pingAt = ping?.checkedAt && ping.weeklyPercent !== null ? Date.parse(ping.checkedAt) : NaN;
  if (Number.isFinite(pingAt) && (!snapshot || pingAt > snapshot.asOf))
    return { used: ping!.weeklyPercent as number, resetsAt: snapshot?.resetsAt ?? null, asOf: pingAt,
      minutes: snapshot?.minutes ?? null, plan: snapshot?.plan ?? null, source: "auto_ping" };
  return snapshot ? { ...snapshot, source: "manager_snapshot" } : null;
}

const meta = (p: Picked & { source?: LocalSource }): LocalWindow =>
  ({ resets_at: p.resetsAt, as_of: iso(p.asOf), source: p.source ?? "manager_snapshot" });

/**
 * One account's usage from CPA Manager's stored state, shaped like the previous usage-endpoint
 * result so clients read it unchanged. Returns null when nothing is stored for the account.
 * `as_of` is the newest observation among its windows.
 */
export function buildLocalUsage(account: ManagerAccount, state: LocalState, now = Date.now()): Record<string, unknown> | null {
  const windows = state.snapshots.get(account.id) ?? [];
  const ping = account.fileName ? state.autoPing.get(account.fileName) : undefined;
  const checked = { source: "local", checked_at: iso(now),
    auto_ping: ping ? { status: ping.status, checked_at: ping.checkedAt } : null };
  // Not available from local state; null rather than a remembered value.
  const unavailable = { reset_credits: null, subscription: null };

  if (account.provider === "claude") {
    const all = (id: string) => (w: SnapshotWindow) => w.provider_window_id === id && (w.model_scope_kind ?? "all") === "all";
    const five = pick(windows, all("five-hour"), now);
    const week = weekly(pick(windows, all("seven-day"), now), ping);
    if (!five && !week) return null;
    const claudeWindow = (p: (Picked & { source?: LocalSource }) | null) => p ? { utilization: p.used, ...meta(p) } : null;
    return {
      five_hour: claudeWindow(five), seven_day: claudeWindow(week),
      seven_day_sonnet: null, seven_day_opus: null, seven_day_design: null, seven_day_fable: null,
      subscription_type: null, ...unavailable, connection_id: account.id, ...checked,
      as_of: iso(Math.max(five?.asOf ?? 0, week?.asOf ?? 0)),
    };
  }

  const main = (kind: string) => (w: SnapshotWindow) => w.window_kind === kind && w.model_scope_key === "codex_main";
  const five = pick(windows, main("five_hour"), now);
  const day = pick(windows, main("daily"), now);
  const week = weekly(pick(windows, main("weekly"), now), ping);
  if (!five && !day && !week) return null;
  const codexWindow = (p: (Picked & { source?: LocalSource }) | null, minutes: number) =>
    p ? { used_percent: p.used, window_minutes: p.minutes ?? minutes, ...meta(p) } : null;
  const fiveHour = codexWindow(five, 300);
  const sevenDay = codexWindow(week, 10080);
  return {
    plan_type: week?.plan ?? day?.plan ?? five?.plan ?? null,
    five_hour: fiveHour, one_day: codexWindow(day, 1440), seven_day: sevenDay,
    primary: fiveHour, secondary: sevenDay, additional: [], credits_balance: null,
    ...unavailable, ...checked,
    as_of: iso(Math.max(five?.asOf ?? 0, day?.asOf ?? 0, week?.asOf ?? 0)),
  };
}

/** Whether local state says the sign-in is rejected: the proxy's credential status, or auto-ping's quota check answered 401/403. */
export function loginRejected(proxyExpired: boolean, ping: AutoPingAccount | undefined): boolean {
  return proxyExpired || ping?.quotaHttpStatus === 401 || ping?.quotaHttpStatus === 403;
}
