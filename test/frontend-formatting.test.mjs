import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const match = html.match(/function fmtRel\(iso\) \{[\s\S]*?\n\}/);
assert.ok(match, "fmtRel function should exist in public/index.html");

function loadFmtRel(nowIso = "2026-01-01T00:00:00.000Z") {
  const sandbox = {
    Date: class extends Date {
      constructor(...args) {
        super(...args);
      }
      static now() {
        return new Date(nowIso).getTime();
      }
    },
    Number,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${match[0]}; globalThis.fmtRel = fmtRel;`, sandbox);
  return sandbox.fmtRel;
}

function loadHistoryOutlierHelpers() {
  const helperMatch = html.match(/const LOW_DROPOUT_VALUE = 5;[\s\S]*?function cleanedHistoryPoints\(points\) \{[\s\S]*?\n\}/);
  assert.ok(helperMatch, "history dropout cleanup helpers should exist");
  const sandbox = { Date, Number, Math };
  vm.createContext(sandbox);
  vm.runInContext(`${helperMatch[0]}; globalThis.cleanedHistoryPoints = cleanedHistoryPoints;`, sandbox);
  return sandbox.cleanedHistoryPoints;
}

test("fmtRel shows days plus hours for reset times more than a day away", () => {
  const fmtRel = loadFmtRel();

  assert.equal(fmtRel("2026-01-03T03:00:00.000Z"), "in 2d 3h");
});

test("fmtRel keeps hour and minute precision for sub-day reset times", () => {
  const fmtRel = loadFmtRel();

  assert.equal(fmtRel("2026-01-01T02:15:00.000Z"), "in 2h 15m");
});

test("dashboard defaults to cards with a tab for switching to history graph", () => {
  assert.match(html, /<button[^>]+data-view="cards"[^>]*class="[^"]*active[^"]*"[^>]*>cards<\/button>/);
  assert.match(html, /<button[^>]+data-view="history"[^>]*>graph<\/button>/);
  assert.match(html, /<main id="grid" class="view">/);
  assert.match(html, /<section class="history view hidden">/);
});

test("history graph exposes all known provider series with preferred color families", () => {
  const options = [...html.matchAll(/\{ key: "([^"]+)", label: "([^"]+)", color: "(#[0-9a-fA-F]+)", default: (true|false) \}/g)]
    .map((match) => ({ key: match[1], label: match[2], color: match[3], default: match[4] === "true" }));

  assert.deepEqual(options, [
    { key: "claude:five_hour", label: "Claude Code 5-hour", color: "#f97316", default: true },
    { key: "claude:seven_day", label: "Claude Code 7-day", color: "#fb923c", default: true },
    { key: "claude:seven_day_sonnet", label: "Claude Sonnet 7-day", color: "#fdba74", default: false },
    { key: "claude:seven_day_opus", label: "Claude Opus 7-day", color: "#ea580c", default: false },
    { key: "claude:seven_day_design", label: "Claude Design 7-day", color: "#fed7aa", default: false },
    { key: "claude:seven_day_fable", label: "Claude Fable 7-day", color: "#c2410c", default: true },
    { key: "codex:five_hour", label: "Codex 5-hour", color: "#22c55e", default: false },
    { key: "codex:one_day", label: "Codex 24-hour", color: "#4ade80", default: true },
    { key: "codex:seven_day", label: "Codex 7-day", color: "#86efac", default: true },
    { key: "codex:GPT-5.3-Codex-Spark five_hour", label: "Codex Spark 5-hour", color: "#06b6d4", default: false },
    { key: "codex:GPT-5.3-Codex-Spark seven_day", label: "Codex Spark 7-day", color: "#67e8f9", default: false },
    { key: "codex2:five_hour", label: "Codex #2 5-hour", color: "#3b82f6", default: false },
    { key: "codex2:one_day", label: "Codex #2 24-hour", color: "#60a5fa", default: false },
    { key: "codex2:seven_day", label: "Codex #2 7-day", color: "#93c5fd", default: false },
    { key: "codex2:GPT-5.3-Codex-Spark five_hour", label: "Codex #2 Spark 5-hour", color: "#8b5cf6", default: false },
    { key: "codex2:GPT-5.3-Codex-Spark seven_day", label: "Codex #2 Spark 7-day", color: "#c4b5fd", default: false },
    { key: "zai:five_hour", label: "ZAI 5-hour", color: "#a855f7", default: true },
    { key: "zai:monthly", label: "ZAI monthly", color: "#d8b4fe", default: false },
    { key: "claude2:five_hour", label: "Claude #2 Code 5-hour", color: "#f59e0b", default: true },
    { key: "claude2:seven_day", label: "Claude #2 Code 7-day", color: "#fbbf24", default: true },
    { key: "claude2:seven_day_sonnet", label: "Claude #2 Sonnet 7-day", color: "#fcd34d", default: false },
    { key: "claude2:seven_day_opus", label: "Claude #2 Opus 7-day", color: "#d97706", default: false },
    { key: "claude2:seven_day_design", label: "Claude #2 Design 7-day", color: "#fde68a", default: false },
    { key: "claude2:seven_day_fable", label: "Claude #2 Fable 7-day", color: "#b45309", default: true },
  ]);
  assert.match(html, /id="history-series-menu"/);
  assert.match(html, /selectedSeriesKeys\.has/);
});

test("history series menu supports bulk actions and localStorage persistence", () => {
  assert.match(html, /data-series-action="all"/);
  assert.match(html, /data-series-action="none"/);
  assert.match(html, /data-series-action="default"/);
  assert.match(html, /localStorage\.getItem\("usage-api:selected-history-series"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:selected-history-series"/);
});

test("history series menu supports inline per-series expected-line checkboxes with tooltip labels", () => {
  assert.match(html, /EXPECTED_SERIES_STORAGE_KEY = "usage-api:expected-history-series"/);
  assert.match(html, /loadExpectedSeriesKeys\(\)/);
  assert.match(html, /saveExpectedSeriesKeys\(\)/);
  assert.match(html, /data-expected-series-key/);
  assert.match(html, /class="series-row/);
  assert.match(html, /class="expected-toggle"/);
  assert.match(html, /title="Show expected percentages"/);
  assert.match(html, /aria-label="Show expected percentages"/);
  assert.doesNotMatch(html, /> Show expected percentages<\/label>/);
  assert.match(html, /expectedSeriesKeys\.has\(item\.key\)/);
});

test("history graph supports a persisted 5-hour squash-by-four toggle", () => {
  assert.match(html, /id="history-squash-five-hour"/);
  assert.match(html, /Squash 5-hour ×¼/);
  assert.match(html, /localStorage\.getItem\("usage-api:squash-five-hour"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:squash-five-hour"/);
  assert.match(html, /function isFiveHourSeries\(key\)/);
  assert.match(html, /function scaledHistoryValue\(item, value\)/);
  assert.ok(html.includes('return squashFiveHour && isFiveHourSeries(item.key) ? value / 4 : value'));
});

test("history graph supports persisted time ranges and previous/next navigation", () => {
  assert.match(html, /data-history-range="1d"/);
  assert.match(html, /data-history-range="7d"/);
  assert.match(html, /data-history-range="14d"/);
  assert.match(html, /data-history-range="1M"/);
  assert.match(html, /data-history-range="2M"/);
  assert.match(html, /id="history-prev-window"/);
  assert.match(html, /id="history-next-window"/);
  assert.match(html, /localStorage\.getItem\("usage-api:history-range"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:history-range", historyRange\)/);
  assert.match(html, /function rangeDurationMs\(range\)/);
  assert.match(html, /function visibleHistoryPoints\(points\)/);
  assert.match(html, /function shiftHistoryWindow\(direction\)/);
});

test("dashboard remembers selected view and history granularity", () => {
  assert.match(html, /localStorage\.getItem\("usage-api:selected-view"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:selected-view", view\)/);
  assert.match(html, /localStorage\.getItem\("usage-api:history-granularity"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:history-granularity", granularity\)/);
  assert.match(html, /applySelectedView\(loadSelectedView\(\), \{ fetch: false \}\)/);
  assert.match(html, /applyHistoryGranularity\(historyGranularity, \{ fetch: false \}\)/);
});

test("history chart colors dots, range bars, and expected lines with each series color", () => {
  assert.match(html, /<polyline class="line" stroke="\$\{item\.color\}"/);
  assert.match(html, /<polyline class="expected-line" stroke="\$\{item\.color\}"/);
  assert.doesNotMatch(html, /<polyline class="expected-line" stroke="#fff"/);
  assert.match(html, /expectedCoords/);
  assert.match(html, /expected usage/);
  assert.match(html, /p\.expectedValue/);
  assert.match(html, /if \(latestHistory\) renderHistory\(latestHistory\)/);
  assert.match(html, /<circle class="point" fill="\$\{item\.color\}" stroke="\$\{item\.color\}"/);
  assert.match(html, /<line class="range" stroke="\$\{item\.color\}"/);
  assert.match(html, /\$\{ranges\}<polyline class="line"[\s\S]*\$\{expectedLine\}\$\{dots\}/);
  assert.match(html, /stroke-width: 2\.4/);
  assert.match(html, /stroke-linecap: round/);
});

test("history chart shows custom hover popup details for graph dots", () => {
  assert.match(html, /id="history-tooltip"/);
  assert.match(html, /class="history-tooltip hidden"/);
  assert.match(html, /data-tooltip="\$\{escapeHtml\(tooltip\)\}"/);
  assert.match(html, /showHistoryTooltip\(event\)/);
  assert.match(html, /hideHistoryTooltip\(\)/);
});

test("history chart includes readable axes, range bars, and rolling-window help text", () => {
  assert.match(html, /\[100, 75, 50, 25, 0\]/);
  assert.match(html, /class="range"/);
  assert.match(html, /class="grid-line"/);
  assert.match(html, /Codex 7-day is a rolling window/);
  assert.match(html, /Aggregated views show average dots plus min–max bars/);
});

test("history chart expected line uses per-point expected values without flat fallback", () => {
  assert.match(html, /p\.expectedValue != null/);
  assert.match(html, /seriesY\(scaledHistoryValue\(item, p\.expectedValue\)\)/);
  assert.doesNotMatch(html, /fallbackExpected/);
  assert.doesNotMatch(html, /currentExpectedForSeries/);
});

test("history chart removes short zero dropouts without hiding real reset ramps", () => {
  const cleanedHistoryPoints = loadHistoryOutlierHelpers();
  const t = (minutes) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

  const dropout = [
    { t: t(0), value: 90 },
    { t: t(1), value: 0 },
    { t: t(2), value: 0 },
    { t: t(3), value: 89 },
  ];
  assert.deepEqual([...cleanedHistoryPoints(dropout).map((p) => p.value)], [90, 89]);

  const closerToPreviousThanZero = [
    { t: t(0), value: 12 },
    { t: t(1), value: 0 },
    { t: t(2), value: 7 },
    { t: t(3), value: 8 },
  ];
  assert.deepEqual([...cleanedHistoryPoints(closerToPreviousThanZero).map((p) => p.value)], [12, 7, 8]);

  const realReset = [
    { t: t(0), value: 95 },
    { t: t(1), value: 0 },
    { t: t(2), value: 1 },
    { t: t(3), value: 2 },
    { t: t(4), value: 3 },
  ];
  assert.deepEqual([...cleanedHistoryPoints(realReset).map((p) => p.value)], [95, 0, 1, 2, 3]);
});

test("Codex card omits unavailable 5-hour metrics without a notice", () => {
  assert.match(html, /windowRow\("5-hour", d\.five_hour\)/);
  assert.match(html, /windowRow\("7-day", d\.seven_day\)/);
  assert.doesNotMatch(html, /5-hour limit is not currently reported/);
  assert.doesNotMatch(html, /metricRow\("primary", d\.primary/);
});

function loadRenderCodex() {
  const names = ["fmtPct", "fmtTime", "fmtRel", "barClass", "bar", "metricRow", "resetCreditCounts", "renderResetCredits", "renderCodex"];
  const src = names.map((name) => {
    const fn = html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(fn, `${name} should exist in public/index.html`);
    return fn[0];
  }).join("\n");
  const esc = html.match(/function escapeHtml\(s\) \{.*\}/)[0];
  const sandbox = { Date, Number, Math, String, isNaN };
  vm.createContext(sandbox);
  vm.runInContext(`${esc}\n${src}; globalThis.renderCodex = renderCodex; globalThis.renderResetCredits = renderResetCredits;`, sandbox);
  return Object.assign(sandbox.renderCodex, { renderResetCredits: sandbox.renderResetCredits });
}

test("Codex card shows a 24-hour window as its own row, never as the 5-hour one", () => {
  const renderCodex = loadRenderCodex();
  const resets = new Date(Date.now() + 12 * 3600_000).toISOString();
  const dayOnly = renderCodex({ data: { five_hour: null, seven_day: null, additional: [],
    one_day: { used_percent: 12, expected_percent: 50, resets_at: resets, window_minutes: 1440 } } });
  assert.match(dayOnly, /<div class="label">24-hour<\/div>/);
  assert.match(dayOnly, /12\.0%/);
  assert.doesNotMatch(dayOnly, /<div class="label">5-hour<\/div>/);
  assert.doesNotMatch(dayOnly, /5-hour limit is not currently reported/);
  assert.match(dayOnly, /no 7-day limit is currently reported by Codex/);

  const normal = renderCodex({ data: { additional: [], one_day: null,
    five_hour: { used_percent: 5, resets_at: resets }, seven_day: { used_percent: 40, resets_at: resets } } });
  assert.match(normal, /<div class="label">5-hour<\/div>/);
  assert.match(normal, /<div class="label">7-day<\/div>/);
  assert.doesNotMatch(normal, /24-hour/);
  assert.doesNotMatch(normal, /not currently reported/);

  const weeklyOnly = renderCodex({ data: { additional: [], five_hour: null, one_day: null, seven_day: { used_percent: 40, resets_at: resets } } });
  assert.match(weeklyOnly, /<div class="label">7-day<\/div>/);
  assert.doesNotMatch(weeklyOnly, /5-hour/);
  assert.doesNotMatch(weeklyOnly, /no 7-day limit/);
});

test("optional second Codex account remains separate and clearly labeled", () => {
  assert.match(html, /codex2: renderCodex/);
  assert.match(html, /codex2: "codex #2"/);
  assert.match(html, /name\.slice\(family\.length\) \|\| "1"/);
  assert.match(html, /hasCodex2 = !!j\.providers\.codex2\?\.data/);
  assert.match(html, /Object\.keys\(j\.providers\)/);
  assert.match(html, /codex2Visible\(\) \|\| !option\.key\.startsWith\("codex2:"\)/);
});

test("new accounts acquire independent history series without duplicating existing ones", () => {
  const fn = html.match(/function discoverAccountSeries\(keys\) \{[\s\S]*?\n\}/)[0];
  const storage = new Map();
  const sandbox = { CURATED_HISTORY_SERIES: [
    { key: "codex:seven_day", label: "Codex 7-day", default: true },
    { key: "claude:seven_day_fable", label: "Claude Fable 7-day", default: true },
  ], selectedSeriesKeys: new Set(), localStorage: { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value) }, saveSelectedSeriesKeys: () => {} };
  vm.createContext(sandbox);
  vm.runInContext(fn + '; discoverAccountSeries(["codex3", "claude12", "codex3", "openai"]); discoverAccountSeries(["codex3"]);', sandbox);
  assert.equal(sandbox.CURATED_HISTORY_SERIES.length, 4);
  assert.equal(sandbox.CURATED_HISTORY_SERIES[2].label, "Codex #3 7-day");
  assert.ok(sandbox.selectedSeriesKeys.has("claude12:seven_day_fable"));
  sandbox.selectedSeriesKeys.delete("codex3:seven_day");
  sandbox.CURATED_HISTORY_SERIES.splice(2);
  vm.runInContext('discoverAccountSeries(["codex3"]);', sandbox);
  assert.ok(!sandbox.selectedSeriesKeys.has("codex3:seven_day"), "A saved hidden series should stay hidden on reload");
});

test("dashboard cards link to provider usage pages", () => {
  assert.match(html, /PROVIDER_LINKS/);
  assert.match(html, /claude\.ai\/settings\/usage/);
  assert.match(html, /chatgpt\.com\/codex\/cloud\/settings\/analytics#usage/);
  assert.match(html, /z\.ai\/manage-apikey\/subscription#usage/);
  assert.match(html, /class="provider-link"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener"/);
});

test("history graph renders separate per-series graphs", () => {
  assert.match(html, /function renderOneSeries/);
  assert.match(html, /selected\.map\(item => renderOneSeries/);
});

test("account cards show the manual renewal date", () => {
  const fn = html.match(/function fmtRenewal\(r\) \{[\s\S]*?\n\}/);
  const esc = html.match(/function escapeHtml\(s\) \{.*\}/);
  assert.ok(fn && esc, "fmtRenewal should exist in public/index.html");
  assert.match(html, /fmtExpiry\(snap\?\.expiry\) \|\| fmtRenewal\(snap\?\.renewal\)/);
  const sandbox = { Date, Number, String };
  vm.createContext(sandbox);
  vm.runInContext(`${esc[0]} ${fn[0]}; globalThis.fmtRenewal = fmtRenewal;`, sandbox);
  assert.equal(sandbox.fmtRenewal(null), "");
  const out = sandbox.fmtRenewal({ renews_at: "2026-11-10", billing_cycle: "monthly", days_until_renewal: 7, source: "manual" });
  assert.match(out, /renews in 7d \(.*2026.*\) · monthly/);
  assert.match(sandbox.fmtRenewal({ renews_at: "2026-11-03", billing_cycle: "yearly", days_until_renewal: 0 }), /renews today/);
  assert.match(out, /title="Set manually/);
  assert.match(sandbox.fmtRenewal({ renews_at: "2026-12-07", billing_cycle: "monthly", days_until_renewal: 24, source: "provider" }), /title="Reported by the provider/);
});

test("account cards show a subscription end as a warning in place of the renewal", () => {
  const pick = (name) => html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0];
  const esc = html.match(/function escapeHtml\(s\) \{.*\}/)[0];
  const attr = html.match(/function escapeAttr\(s\) \{.*\}/)[0];
  const sandbox = { Date, Number, String };
  vm.createContext(sandbox);
  vm.runInContext(`${esc} ${attr} ${pick("fmtExpiry")} ${pick("fmtSubscriptionStatus")};
    globalThis.fmtExpiry = fmtExpiry; globalThis.fmtSubscriptionStatus = fmtSubscriptionStatus;`, sandbox);
  assert.equal(sandbox.fmtExpiry(null), "");
  const far = sandbox.fmtExpiry({ expires_at: "2026-12-09", days_until_expiry: 26, source: "provider", ends_at: "2026-12-09T06:15:18.000Z" });
  assert.match(far, /class="sub expiry"/);
  assert.match(far, /expires in 26d \(.*2026.*\)/);
  assert.match(far, /will not renew/);
  const near = sandbox.fmtExpiry({ expires_at: "2026-11-15", days_until_expiry: 2, source: "manual", ends_at: null });
  assert.match(near, /class="sub expiry soon"/);
  assert.match(near, /Set manually/);
  assert.match(sandbox.fmtExpiry({ expires_at: "2026-11-10", days_until_expiry: -3, source: "manual" }), /expired 3d ago/);
  assert.match(sandbox.fmtExpiry({ expires_at: "2026-11-13", days_until_expiry: 0, source: "manual" }), /expires today/);
  assert.equal(sandbox.fmtSubscriptionStatus({ status: "active" }, null), "");
  assert.equal(sandbox.fmtSubscriptionStatus({ status: "canceled" }, { expires_at: "2026-12-01" }), "");
  assert.match(sandbox.fmtSubscriptionStatus({ status: "past_due" }, null), /subscription past_due/);
});

test("Claude card shows a 5-hour row only when the account reports one", () => {
  assert.match(html, /\$\{sub\("5-hour", d\.five_hour\)\}/);
});

function loadAccountStatusHelpers(nowIso = "2026-01-01T00:00:00.000Z") {
  const block = html.match(/\/\/ --- account status helpers[\s\S]*?\/\/ --- end account status helpers ---/);
  assert.ok(block, "account status helpers should exist in public/index.html");
  const fmtTime = html.match(/function fmtTime\(iso\) \{[\s\S]*?\n\}/)[0];
  const sandbox = {
    Date: class extends Date { static now() { return new Date(nowIso).getTime(); } },
    Number, Math, String, Infinity,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${fmtTime}\n${block[0]}\nglobalThis.h = { availability, fmtAvailability, sortProviderKeys, fmtPriority, accountEmail, dataAgeTooltip };`, sandbox);
  return sandbox.h;
}

test("availability: per-model windows don't block, latest reset among full account-wide windows wins", () => {
  const h = loadAccountStatusHelpers();
  const claude = { data: { five_hour: null, seven_day: { utilization: 40, resets_at: "2026-01-05T00:00:00Z" },
    seven_day_fable: { utilization: 100, resets_at: "2026-01-03T00:00:00Z" } } };
  assert.equal(h.availability("claude3", claude).blocked, false);
  const codex = { data: {
    five_hour: { used_percent: 100, resets_at: "2026-01-01T02:00:00Z" },
    one_day: null,
    seven_day: { used_percent: 99.6, resets_at: "2026-01-03T05:00:00Z" },
    additional: [{ five_hour: { used_percent: 100 } }] } };
  const a = h.availability("codex", codex);
  assert.equal(a.blocked, true);
  assert.equal(a.availableAt, "2026-01-03T05:00:00.000Z");
  assert.equal(h.fmtAvailability(a.blocked, a.availableAt), "2d 5h");
  assert.equal(h.fmtAvailability(true, "2026-01-01T04:58:30Z"), "4h 58m");
  assert.equal(h.fmtAvailability(true, "2026-01-01T00:00:20Z"), "<1m");
  assert.equal(h.fmtAvailability(true, "2025-12-31T23:00:00Z"), "live");
  assert.equal(h.fmtAvailability(true, null), "out");
  assert.equal(h.fmtAvailability(false, null), "live");
  const unknown = h.availability("claude", { data: { five_hour: { utilization: 100, resets_at: null }, seven_day: { utilization: 10 } } });
  assert.equal(unknown.blocked, true);
  assert.equal(unknown.availableAt, null);
});

test("cards group Codex, Claude, then others; priority highest first, unset last", () => {
  const h = loadAccountStatusHelpers();
  const p = (priority, name) => ({ account: { priority, name } });
  const providers = {
    claude: p(null, "a@x.com"), claude3: p(5, "b@x.com"), claude4: p(10, "c@x.com"),
    codex: p(1, "d@x.com"), codex2: p(null, "e@x.com"), codex3: p(3, "f@x.com"),
    zai: {}, jev: {}, openrouter: {}, openai: {},
  };
  const keys = ["claude", "claude3", "claude4", "codex", "codex2", "codex3", "zai", "jev", "openrouter", "openai"];
  assert.deepEqual([...h.sortProviderKeys(keys, providers)],
    ["codex3", "codex", "codex2", "claude4", "claude3", "claude", "zai", "jev", "openrouter", "openai"]);
  assert.equal(h.fmtPriority(10), "P10");
  assert.equal(h.fmtPriority(null), null);
  assert.equal(h.accountEmail("claude3", { account: { name: "claude3" } }), null);
});

test("data age tooltip names the passive/active source", () => {
  const h = loadAccountStatusHelpers();
  const tip = h.dataAgeTooltip({ fetchedAt: "2025-12-31T23:50:00Z", dataSource: "passive", staleness: "fresh", observedAt: "2025-12-31T23:50:00Z" });
  assert.match(tip, /^Data 10m ago: seen in CPA request headers \(passive\)/);
  assert.match(tip, /Last seen in traffic/);
});

test("reset credits read per limit when Claude splits them, and as one count otherwise", () => {
  const { renderResetCredits } = loadRenderCodex();
  const split = renderResetCredits({ available_count: 3, weekly_available: 1, fable_available: 2, other_available: 0, next_expires_at: null });
  assert.match(split, /↻ 1 weekly reset · 2 Fable resets available/);
  assert.doesNotMatch(split, /other/);
  assert.match(renderResetCredits({ available_count: 1, weekly_available: 0, fable_available: 0, other_available: 1 }), /↻ 1 other reset available/);
  assert.match(renderResetCredits({ available_count: 2, next_expires_at: null }), /↻ 2 full resets available/);
  assert.equal(renderResetCredits({ available_count: 0, weekly_available: 0, fable_available: 0, other_available: 0 }), "");
});

test("stale cards dim their content but keep the refresh indicators at full strength", () => {
  assert.doesNotMatch(html, /\.card\.stale-data \{ opacity/);
  assert.match(html, /\.card\.stale-data \.title-text, \.card\.stale-data \.acct, \.card\.stale-data \.body \{ opacity: 0\.7; \}/);
  assert.match(html, /\.card\.stale-data h2 \.stamp \{ color: var\(--warn\); \}/);
  // The status dot sits outside the dimmed title text.
  assert.match(html, /<span class="title-main">\$\{statusDot\(snap\)\}<span class="title-text">/);
});
