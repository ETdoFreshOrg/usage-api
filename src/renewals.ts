// Manually set subscription renewal dates per account key (claude, codex3, ...).
// Stored as calendar dates in usage-renewals.json beside the history file;
// hand edits to that file are picked up on the next read. The stored date is
// an anchor: output rolls it forward by whole billing cycles once it passes.
import { readFileSync, statSync, promises as fs } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";

export type BillingCycle = "monthly" | "yearly";
export interface RenewalSetting { renews_at: string; billing_cycle: BillingCycle }
export interface Renewal { renews_at: string; billing_cycle: BillingCycle; days_until_renewal: number; source: "manual" }

export const ACCOUNT_KEY = /^(claude|codex)\d*$/;
export const DEFAULT_TIME_ZONE = "America/Chicago";
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

// Next billing dates as of 2026-11-03 (America/Chicago). Applied only to keys
// with no stored entry, so later edits and deletions are never overwritten.
export const SEED_RENEWALS: Record<string, RenewalSetting> = {
  codex: { renews_at: "2026-11-10", billing_cycle: "monthly" },   // etdofresh@gmail.com
  codex2: { renews_at: "2026-11-12", billing_cycle: "monthly" },  // etdofresh+dev@gmail.com
  codex3: { renews_at: "2026-11-15", billing_cycle: "monthly" },  // etdofreshai@gmail.com
  claude4: { renews_at: "2026-11-17", billing_cycle: "monthly" }, // etdofresh@gmail.com
  claude3: { renews_at: "2026-11-27", billing_cycle: "monthly" }, // etgarcia@uno.edu
  claude: { renews_at: "2026-12-02", billing_cycle: "monthly" },  // etdofreshai@gmail.com
};

function parseDate(s: string): [number, number, number] | null {
  const m = DATE.exec(s);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d ? [y, mo, d] : null;
}
const fmtDate = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Today's calendar date (YYYY-MM-DD) in the given time zone. */
export function todayIn(timeZone: string, now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Anchor plus n months, keeping the anchor's day and clamping to short months (Jan 31 → Feb 28 → Mar 31). */
function addMonths([y, m, d]: [number, number, number], n: number): number {
  const first = Date.UTC(y, m - 1 + n, 1);
  const lastDay = new Date(Date.UTC(y, m + n, 0)).getUTCDate();
  return first + (Math.min(d, lastDay) - 1) * DAY_MS;
}

/** The first renewal on or after today, stepping from the stored anchor by whole cycles. */
export function nextRenewal(setting: RenewalSetting, today: string): Renewal {
  const anchor = parseDate(setting.renews_at)!;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const step = setting.billing_cycle === "yearly" ? 12 : 1;
  let k = 0;
  while (addMonths(anchor, k * step) < todayMs) k++;
  const next = addMonths(anchor, k * step);
  return { renews_at: fmtDate(next), billing_cycle: setting.billing_cycle, days_until_renewal: Math.round((next - todayMs) / DAY_MS), source: "manual" };
}

/** Validates user input; returns the normalized setting or an error message. */
export function parseSetting(body: any): RenewalSetting | string {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.renews_at !== "string" || !parseDate(body.renews_at)) return "renews_at must be a YYYY-MM-DD date";
  const cycle = body.billing_cycle ?? "monthly";
  if (cycle !== "monthly" && cycle !== "yearly") return "billing_cycle must be monthly or yearly";
  return { renews_at: body.renews_at, billing_cycle: cycle };
}

export class RenewalStore {
  // null = deliberately cleared; kept so seeding never brings it back.
  private entries: Record<string, RenewalSetting | null> = {};
  private mtimeMs = -1;
  private write: Promise<void> = Promise.resolve();

  constructor(private filePath: string | null, private timeZone = DEFAULT_TIME_ZONE) {}

  /** Load the file and add seeds for keys it has never held. */
  async load(seeds: Record<string, RenewalSetting> = {}) {
    this.reload(true);
    const missing = Object.keys(seeds).filter(k => !(k in this.entries));
    if (!missing.length) return;
    for (const k of missing) this.entries[k] = seeds[k];
    await this.save();
  }

  private reload(force = false) {
    if (!this.filePath) return;
    let mtimeMs: number;
    try { mtimeMs = statSync(this.filePath).mtimeMs; }
    catch (err: any) { if (err?.code !== "ENOENT") console.warn(`could not stat ${this.filePath}: ${err?.message ?? err}`); return; }
    if (!force && mtimeMs === this.mtimeMs) return;
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8"));
      const next: Record<string, RenewalSetting | null> = {};
      for (const [key, value] of Object.entries(raw ?? {})) {
        if (value === null) { next[key] = null; continue; }
        const parsed = parseSetting(value);
        if (typeof parsed === "string") console.warn(`${this.filePath}: ignoring ${key}: ${parsed}`);
        else next[key] = parsed;
      }
      this.entries = next;
      this.mtimeMs = mtimeMs;
    } catch (err: any) {
      // Keep the last good entries while a hand edit is half-written.
      console.warn(`could not read ${this.filePath}: ${err?.message ?? err}`);
    }
  }

  private save() {
    if (!this.filePath) return Promise.resolve();
    const file = this.filePath;
    const body = JSON.stringify(this.entries, null, 2) + "\n";
    this.write = this.write.then(async () => {
      await fs.writeFile(`${file}.tmp`, body, "utf8");
      await fs.rename(`${file}.tmp`, file);
      this.mtimeMs = (await fs.stat(file)).mtimeMs;
    });
    return this.write;
  }

  get(key: string, now = Date.now()): Renewal | null {
    this.reload();
    const setting = this.entries[key];
    return setting ? nextRenewal(setting, todayIn(this.timeZone, now)) : null;
  }

  all(now = Date.now()): Record<string, Renewal | null> {
    this.reload();
    return Object.fromEntries(Object.keys(this.entries).map(k => [k, this.get(k, now)]));
  }

  async set(key: string, setting: RenewalSetting | null) {
    this.reload();
    this.entries[key] = setting;
    await this.save();
  }
}

const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * GET /api/renewals is public like /api/usage. PUT/DELETE /api/renewals/:account
 * need `Authorization: Bearer <owner key>` (USAGE_MCP_OWNER_KEY); without a key
 * they answer 503.
 */
export function installRenewals(app: express.Express, store: RenewalStore, ownerKey?: string) {
  app.get("/api/renewals", (_req, res) => { res.json({ renewals: store.all() }); });
  const limiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-7", legacyHeaders: false });
  const guard: express.RequestHandler = (req, res, next) => {
    if (!ownerKey) { res.status(503).json({ error: "Renewal editing is not configured (USAGE_MCP_OWNER_KEY not set)" }); return; }
    const token = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1]?.trim() ?? "";
    if (!equal(token, ownerKey)) { res.status(401).json({ error: "Owner key required" }); return; }
    if (!ACCOUNT_KEY.test(req.params.account)) { res.status(400).json({ error: "account must be a Claude or Codex key such as claude3 or codex" }); return; }
    next();
  };
  app.put("/api/renewals/:account", limiter, guard, express.json({ limit: "4kb" }), async (req, res) => {
    const setting = parseSetting(req.body);
    if (typeof setting === "string") { res.status(400).json({ error: setting }); return; }
    await store.set(req.params.account, setting);
    res.json({ account: req.params.account, stored: setting, renewal: store.get(req.params.account) });
  });
  app.delete("/api/renewals/:account", limiter, guard, async (req, res) => {
    await store.set(req.params.account, null);
    res.json({ account: req.params.account, renewal: null });
  });
}
