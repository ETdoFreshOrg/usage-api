import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Poller } from "./cache.js";
import { HistoryGranularity, HistoryStore } from "./history.js";
import { assignAccounts } from "./accounts.js";
import { CliProxyClient } from "./providers/cliproxy.js";
import { RecentRequests } from "./recent.js";

// Load env from the shared volume (same .env that ai-sessions uses) so secrets
// live alongside the OAuth credentials instead of in Dokploy. Run before any
// `process.env.*` reads below.
const ENV_FILE = process.env.SHARED_ENV_FILE ?? "/home/node/workspace/.env";
try {
  const raw = await fs.readFile(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  console.log(`loaded env from ${ENV_FILE}`);
} catch (err: any) {
  if (err?.code !== "ENOENT") console.warn(`could not read ${ENV_FILE}: ${err?.message ?? err}`);
}
import { fetchClaudeUsage } from "./providers/anthropic.js";
import { fetchCodexUsage } from "./providers/codex.js";
import { listConnections } from "./providers/ninerouter.js";
import { fetchZaiUsage } from "./providers/zai.js";
import { fetchOpenRouterUsage } from "./providers/openrouter.js";
import { fetchOpenAiUsage } from "./providers/openai.js";
import { fetchJevUsage } from "./providers/jev.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
function parseHistoryRetentionMs(value: string | undefined) {
  if (value == null || value === "" || value === "forever" || value === "infinite" || value === "0") return Infinity;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : Infinity;
}
const HISTORY_RETENTION_MS = parseHistoryRetentionMs(process.env.USAGE_HISTORY_RETENTION_DAYS);
const HISTORY_FILE = process.env.USAGE_HISTORY_FILE ?? "/home/node/workspace/usage-history.jsonl";
const history = new HistoryStore({ retentionMs: HISTORY_RETENTION_MS, filePath: HISTORY_FILE });
await history.load();

// Last good raw value per provider, so a restart followed by a 429 still
// serves the previous numbers (with their real fetchedAt) instead of null.
const LAST_FILE = process.env.USAGE_LAST_FILE ?? path.join(path.dirname(HISTORY_FILE), "usage-last.json");
let lastGood: Record<string, { data: unknown; fetchedAt: string }> = {};
try {
  lastGood = JSON.parse(await fs.readFile(LAST_FILE, "utf8"));
} catch (err: any) {
  if (err?.code !== "ENOENT") console.warn(`could not read ${LAST_FILE}: ${err?.message ?? err}`);
}
let lastWrite: Promise<void> = Promise.resolve();
function saveLast(provider: string, data: unknown, fetchedAt: Date) {
  lastGood[provider] = { data, fetchedAt: fetchedAt.toISOString() };
  const body = JSON.stringify(lastGood);
  lastWrite = lastWrite
    .then(async () => {
      await fs.writeFile(`${LAST_FILE}.tmp`, body, "utf8");
      await fs.rename(`${LAST_FILE}.tmp`, LAST_FILE);
    })
    .catch((err) => console.warn(`could not write ${LAST_FILE}: ${err?.message ?? err}`));
}

function remember<T>(provider: string): (data: T, fetchedAt: Date) => void {
  return (data: T, fetchedAt: Date) => {
    saveLast(provider, data, fetchedAt);
    const enriched = enrichProviderData(provider, data);
    if (!/^codex\d*$/.test(provider) || !enriched || typeof enriched !== "object") {
      history.recordProvider(provider, enriched, fetchedAt);
      return;
    }
    // Codex retains primary/secondary as compatibility aliases in /api/usage.
    // Do not duplicate those same values in history alongside the canonical
    // five_hour/seven_day series.
    const { primary: _primary, secondary: _secondary, ...codexData } = enriched as any;
    codexData.additional = (codexData.additional ?? []).map((a: any) => {
      const { primary: _p, secondary: _s, ...rest } = a;
      return rest;
    });
    history.recordProvider(provider, codexData, fetchedAt);
  };
}

// Accept the workspace .env's existing names as fallbacks.
const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.ZAI_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_TOKEN;
const OPENAI_KEY = process.env.OPENAI_ADMIN_KEY; // requires sk-admin-* — keep explicit
const OPENROUTER_MANAGEMENT_KEY = process.env.OPENROUTER_MANAGEMENT_KEY;

// All Claude/Codex account resolution now goes through ET's 9router, which
// owns the OAuth-authenticated accounts and keeps their tokens refreshed.
// usage-api borrows the current token and calls Anthropic/OpenAI directly —
// see providers/ninerouter.js.
//
// An account is named by whichever identifier 9router records for it:
// Codex connections carry an email, Claude ones may only have a display
// name ("Account 1").
const CLAUDE_ACCOUNT = process.env.CLIPROXYAPI_CLAUDE_EMAIL?.trim() || process.env.NINEROUTER_CLAUDE_ACCOUNT?.trim() || undefined;
const CLAUDE2_ACCOUNT = process.env.CLIPROXYAPI_CLAUDE2_EMAIL?.trim() || process.env.NINEROUTER_CLAUDE2_ACCOUNT?.trim() || undefined;
const CODEX_ACCOUNT = process.env.NINEROUTER_CODEX_ACCOUNT?.trim() || "etdofresh@gmail.com";
const CODEX2_ACCOUNT = process.env.NINEROUTER_CODEX2_ACCOUNT?.trim() || "etdofresh+dev@gmail.com";

// Legacy second-account kill switches remain supported. Other active
// connections are discovered automatically and assigned persistent numbers.
const CLAUDE2_OFF = /^(0|false|no|off)$/i.test((process.env.CLAUDE2_ENABLED ?? "").trim());
const CODEX2_OFF = /^(0|false|no|off)$/i.test((process.env.CODEX2_ENABLED ?? "").trim());

const cliProxy = process.env.CLIPROXYAPI_MANAGEMENT_KEY
  ? new CliProxyClient(process.env.CLIPROXYAPI_URL ?? "http://etzminisforumx1pro.lan:8317",
    process.env.CLIPROXYAPI_MANAGEMENT_KEY, JSON.parse(process.env.CLIPROXYAPI_ACCOUNT_ALIASES ?? "{}"))
  : null;

if (!cliProxy) try {
  const connections = listConnections();
  console.log(`9router connections: ${connections.map((c) => `${c.provider}:${c.email ?? c.name}`).join(", ") || "none"}`);
} catch (err: any) {
  console.warn(`could not read 9router's connection store at startup: ${err?.message ?? err}`);
}

const ACCOUNTS_FILE = path.join(path.dirname(HISTORY_FILE), "usage-accounts.json");
let assignments: Record<string, string> = {};
try { assignments = JSON.parse(await fs.readFile(ACCOUNTS_FILE, "utf8")); }
catch (err: any) { if (err?.code !== "ENOENT") throw err; }
const accountPollers = new Map<string, { connectionId: string; name: string; family: string; poller: Poller<unknown> }>();
async function syncAccounts() {
  const connections = cliProxy ? await cliProxy.listAccounts() : listConnections();
  const next = assignAccounts(connections, assignments, {
    claude: CLAUDE_ACCOUNT, claude2: CLAUDE2_ACCOUNT, codex: CODEX_ACCOUNT, codex2: CODEX2_ACCOUNT,
  });
  if (JSON.stringify(next) !== JSON.stringify(assignments)) {
    await fs.writeFile(ACCOUNTS_FILE, JSON.stringify(next), "utf8");
    assignments = next;
  }
  const active = new Set<string>();
  for (const [key, id] of Object.entries(assignments)) {
    const connection = connections.find(c => c.id === id);
    if (!connection || (key === "claude2" && CLAUDE2_OFF) || (key === "codex2" && CODEX2_OFF)) continue;
    active.add(key);
    const existing = accountPollers.get(key);
    if (existing) { existing.name = connection.email ?? connection.name; continue; }
    const family = connection.provider;
    const poller = new Poller<unknown>(key,
      () => cliProxy ? cliProxy.fetchUsage(id) : family === "claude" ? fetchClaudeUsage(id) : fetchCodexUsage(id), remember(key));
    const last = lastGood[key];
    if (last) poller.seed(last.data, last.fetchedAt);
    accountPollers.set(key, { connectionId: id, name: connection.email ?? connection.name, family, poller });
    poller.start();
  }
  for (const [key, account] of accountPollers) {
    if (!active.has(key)) { account.poller.stop(); accountPollers.delete(key); }
  }
}
await syncAccounts();
setInterval(() => { void syncAccounts().catch(err => console.warn("account discovery failed:", err.message)); }, 30_000);
const zai = ZAI_KEY ? new Poller("zai", () => fetchZaiUsage(ZAI_KEY), remember("zai")) : null;
const openrouter = OPENROUTER_KEY ? new Poller("openrouter", () => fetchOpenRouterUsage(OPENROUTER_KEY, OPENROUTER_MANAGEMENT_KEY), remember("openrouter")) : null;
const openai = OPENAI_KEY ? new Poller("openai", () => fetchOpenAiUsage(OPENAI_KEY), remember("openai")) : null;
const jev = OPENROUTER_MANAGEMENT_KEY
  ? new Poller("jev", () => fetchJevUsage(OPENROUTER_MANAGEMENT_KEY))
  : null;

for (const p of [zai, openrouter, openai, jev]) {
  const last = p ? lastGood[p.name] : undefined;
  if (p && last) (p as Poller<any>).seed(last.data, last.fetchedAt);
}
zai?.start();
openrouter?.start();
openai?.start();
jev?.start();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

const recentRequests = process.env.CPA_MANAGER_KEY
  ? new RecentRequests(process.env.CPA_MANAGER_URL ?? "http://etzminisforumx1pro.lan:18317", process.env.CPA_MANAGER_KEY)
  : null;
app.get("/api/recent", async (_req, res) => {
  if (!recentRequests) { res.json({ source: "cliproxyapi", exchanges: [] }); return; }
  try { res.json({ source: "cliproxyapi", exchanges: await recentRequests.get() }); }
  catch { res.status(503).json({ error: "Recent request history is unavailable", exchanges: [] }); }
});

// Pacing math: given a window of length windowMs ending at resetAt, compute
// what used% would be on a perfectly linear burn from windowStart to now.
// slack = expected − used (positive = under pace, negative = over pace).
function pacing(usedPct: number, resetIso: string | null, windowMs: number) {
  if (!resetIso) return { expected_percent: null, slack: null };
  const reset = Date.parse(resetIso);
  if (!Number.isFinite(reset)) return { expected_percent: null, slack: null };
  const elapsedMs = Date.now() - (reset - windowMs);
  const expected = Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));
  return { expected_percent: expected, slack: expected - usedPct };
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAY_MS = 30 * 24 * 60 * 60 * 1000;

function enrichClaude(snap: { data?: any }) {
  if (!snap.data) return snap;
  const d = snap.data;
  const enrichSeven = <T extends { utilization: number; resets_at: string | null } | null>(w: T): T =>
    (w ? { ...w, ...pacing(w.utilization, w.resets_at, SEVEN_DAY_MS) } : w) as T;
  return {
    ...snap,
    data: {
      ...d,
      // Claude has no 5-hour limit any more; drop it from cached snapshots seeded before the change.
      five_hour: undefined,
      seven_day: enrichSeven(d.seven_day ?? { utilization: 0, resets_at: null }),
      seven_day_sonnet: enrichSeven(d.seven_day_sonnet),
      seven_day_opus: enrichSeven(d.seven_day_opus),
      seven_day_design: enrichSeven(d.seven_day_design),
      seven_day_fable: enrichSeven(d.seven_day_fable),
    },
  };
}

function enrichCodex(snap: { data?: any }) {
  if (!snap.data) return snap;
  const d = snap.data;
  const enrichWin = (w: { used_percent: number; resets_at: string | null; window_minutes: number } | null, fallbackMin: number) => {
    if (!w) return null;
    const ms = (w.window_minutes || fallbackMin) * 60 * 1000;
    return { ...w, ...pacing(w.used_percent, w.resets_at, ms) };
  };
  const fiveHour = enrichWin(d.five_hour, 300);
  const sevenDay = enrichWin(d.seven_day, 10080);
  return {
    ...snap,
    data: {
      ...d,
      five_hour: fiveHour,
      seven_day: sevenDay,
      // Preserve the old API fields, but keep their historical semantic
      // meanings rather than mirroring OpenAI's now-variable raw slots.
      primary: fiveHour,
      secondary: sevenDay,
      additional: d.additional.map((a: any) => {
        const additionalFiveHour = enrichWin(a.five_hour, 300);
        const additionalSevenDay = enrichWin(a.seven_day, 10080);
        return {
          ...a,
          five_hour: additionalFiveHour,
          seven_day: additionalSevenDay,
          primary: additionalFiveHour,
          secondary: additionalSevenDay,
        };
      }),
    },
  };
}

function enrichZai(snap: { data?: any }) {
  if (!("data" in snap) || !snap.data) return snap;
  const d = snap.data;
  return {
    ...snap,
    data: {
      ...d,
      five_hour: d.five_hour
        ? { ...d.five_hour, ...pacing(d.five_hour.used_percent, d.five_hour.resets_at, FIVE_HOUR_MS) }
        : null,
      monthly: d.monthly
        ? { ...d.monthly, ...pacing(d.monthly.used_percent, d.monthly.resets_at, THIRTY_DAY_MS) }
        : null,
    },
  };
}

function enrichProviderData(provider: string, data: unknown): unknown {
  if (/^claude\d*$/.test(provider)) return enrichClaude({ data }).data;
  if (/^codex\d*$/.test(provider)) return enrichCodex({ data }).data;
  if (provider === "zai") return enrichZai({ data }).data;
  return data;
}

app.get("/api/usage", (_req, res) => {
  const providers: Record<string, unknown> = {};
  for (const [key, account] of accountPollers) {
    const snapshot = account.poller.snapshot();
    providers[key] = {
      ...snapshot, data: enrichProviderData(key, snapshot.data),
      account: { id: account.connectionId, name: account.name, family: account.family },
      source: cliProxy ? "cliproxyapi" : "9router",
    };
  }
  providers.zai = zai ? enrichZai(zai.snapshot()) : { data: null, error: "ZAI_API_KEY not set" };
  providers.openrouter = openrouter?.snapshot() ?? { data: null, error: "OPENROUTER_API_KEY not set" };
  providers.openai = openai?.snapshot() ?? { data: null, error: "OPENAI_ADMIN_KEY not set" };
  providers.jev = jev?.snapshot() ?? { data: null, error: "OPENROUTER_MANAGEMENT_KEY not set" };
  res.json({
    timestamp: new Date().toISOString(),
    providers,
  });
});

app.get("/api/history", (req, res) => {
  const requested = typeof req.query.granularity === "string" ? req.query.granularity : "daily";
  const granularity: HistoryGranularity = requested === "fine" || requested === "hourly" || requested === "daily"
    ? requested
    : "daily";
  res.json(history.toSeries(granularity));
});

// Serve the dashboard UI from /public.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js -> ../public ; src/server.ts (tsx) -> ../public
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

app.listen(PORT, () => {
  console.log(`usage-api listening on http://localhost:${PORT}`);
});
