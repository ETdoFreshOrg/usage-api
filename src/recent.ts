export interface RecentExchange {
  startedAt: string; model: string; outcome: string;
  jev: { effort: string | null; resolved: string };
}

export function parseRecentExchanges(body: any): RecentExchange[] {
  if (!Array.isArray(body?.events?.items)) throw new Error("Invalid CPA request history");
  return body.events.items.filter((e: any) => Number.isFinite(e.timestamp_ms) && typeof e.model === "string")
    .sort((a: any, b: any) => b.timestamp_ms - a.timestamp_ms).slice(0, 20)
    .map((e: any) => ({
      startedAt: new Date(e.timestamp_ms).toISOString(),
      model: e.resolved_model || e.response_model || e.model,
      outcome: e.failed ? "error" : "ok",
      jev: { effort: typeof e.reasoning_effort === "string" ? e.reasoning_effort : null,
        resolved: e.resolved_model || e.response_model || e.model },
    }));
}

export class RecentRequests {
  private cached: { at: number; exchanges: RecentExchange[] } | null = null;
  private pending: Promise<RecentExchange[]> | null = null;
  constructor(private readonly url: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  async get(): Promise<RecentExchange[]> {
    if (this.cached && Date.now() - this.cached.at < 5000) return this.cached.exchanges;
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async read() {
    const now = Date.now();
    const response = await this.fetcher(`${this.url.replace(/\/$/, "")}/v0/management/monitoring/analytics`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from_ms: now - 7 * 86400000, to_ms: now, include: { events_page: { limit: 20 } } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`CPA history HTTP ${response.status}`);
    const exchanges = parseRecentExchanges(await response.json());
    this.cached = { at: Date.now(), exchanges };
    return exchanges;
  }
}

// Per-account request counts for the owner-only MCP. Uses the identity CPA
// records on each event (account_snapshot / auth_provider_snapshot); never
// tokens, hashes, IPs or prompts. Not used by the public /api/recent.
export interface AccountActivity {
  provider: string | null; requests: number; errors: number; total_tokens: number; last_at: string;
  models: Record<string, number>;
}
export interface ActivitySummary {
  window_hours: number; total_in_window: number | null; counted: number;
  by_account: Record<string, AccountActivity>;
}

export function parseAccountActivity(body: any, windowHours: number): ActivitySummary {
  if (!Array.isArray(body?.events?.items)) throw new Error("Invalid CPA request history");
  const byAccount: Record<string, AccountActivity> = {};
  let counted = 0;
  for (const e of body.events.items) {
    if (!Number.isFinite(e?.timestamp_ms)) continue;
    counted++;
    const key = typeof e.account_snapshot === "string" && e.account_snapshot ? e.account_snapshot.toLowerCase() : "unknown";
    const a = (byAccount[key] ??= { provider: typeof e.auth_provider_snapshot === "string" ? e.auth_provider_snapshot : null,
      requests: 0, errors: 0, total_tokens: 0, last_at: new Date(e.timestamp_ms).toISOString(), models: {} });
    a.requests++;
    if (e.failed) a.errors++;
    if (Number.isFinite(e.total_tokens)) a.total_tokens += e.total_tokens;
    const at = new Date(e.timestamp_ms).toISOString();
    if (at > a.last_at) a.last_at = at;
    const model = e.resolved_model || e.response_model || e.model;
    if (typeof model === "string") a.models[model] = (a.models[model] ?? 0) + 1;
  }
  const total = body.events.total_count;
  return { window_hours: windowHours, total_in_window: Number.isFinite(total) ? total : null, counted, by_account: byAccount };
}

export class AccountActivityReader {
  private cached = new Map<number, { at: number; value: ActivitySummary }>();
  constructor(private readonly url: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch,
    private readonly limit = 1000) {}
  async get(hours: number): Promise<ActivitySummary> {
    const hit = this.cached.get(hours);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const now = Date.now();
    const response = await this.fetcher(`${this.url.replace(/\/$/, "")}/v0/management/monitoring/analytics`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from_ms: now - hours * 3_600_000, to_ms: now, include: { events_page: { limit: this.limit } } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`CPA history HTTP ${response.status}`);
    const value = parseAccountActivity(await response.json(), hours);
    this.cached.set(hours, { at: Date.now(), value });
    return value;
  }
}
