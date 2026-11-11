# usage-api

Public, no-auth, always-cached aggregator for AI service usage. Polls
Claude / Codex / Z.ai / OpenRouter / OpenAI in the background and serves
the latest snapshot from memory — every request is O(0) network.

Claude and Codex usage is fetched through CLIProxyAPI's authenticated management
`api-call` endpoint when `CLIPROXYAPI_MANAGEMENT_KEY` is set. CLIProxyAPI owns and
refreshes OAuth credentials; Usage API receives provider responses, never access
or refresh tokens. All provider calls are read-only GETs, including reset-credit
details. Each poll reads current data rather than cached quota headers.

Set `CLIPROXYAPI_URL` (default `http://etzminisforumx1pro.lan:8317`) and
`CLIPROXYAPI_MANAGEMENT_KEY`. Optional `CLIPROXYAPI_ACCOUNT_ALIASES` is a JSON map
from old connection IDs to `provider:email` or `provider:email:workspaceId`,
preserving account numbers, history and monitor visibility during migration.
`CLIPROXYAPI_CLAUDE_EMAIL` and `CLIPROXYAPI_CLAUDE2_EMAIL` select the first two
Claude slots on a fresh install. Keep the management key server-side.

For the monitor's recent-model strip, set `CPA_MANAGER_URL` (default
`http://etzminisforumx1pro.lan:18317`) and `CPA_MANAGER_KEY`. `/api/recent` returns
only model, time, effort and outcome for the last 20 recorded requests within
seven days. It does not return credentials, account identities, IPs or prompts.
Concurrent monitor reads share a five-second cache. In-progress requests are
not in the recorded history; unused slots remain grey in the monitor.

Without that key, the legacy source remains available for rollback:
Claude and Codex usage comes straight from Anthropic and OpenAI, using the
OAuth token [9router](https://github.com/9cat/9router) already holds and
refreshes for those accounts. This service manages no Claude/Codex
credential of its own: it reads the current token out of 9router's
connection store and calls the providers' own usage endpoints — see
[9router source](#9router-source-for-claudecodex) below. Z.ai, OpenRouter,
and OpenAI are unaffected and still poll directly with their own API keys.

## Endpoint

```
GET /api/usage
```

Returns per-provider:

- `data` — provider-specific shape (utilization %, reset times, credits, etc.).
  A failed poll keeps the last good value here instead of clearing it; it is
  also saved to `usage-last.json` beside the history file (`USAGE_LAST_FILE`)
  so it survives restarts.
- `fetchedAt` — ISO date-time the numbers in `data` were true (for Claude/Codex
  accounts this is the observed request time when `dataSource` is `passive`)
- `lastAttemptAt` — ISO date-time of the latest poll, success or failure
- `ageSec` — seconds since `fetchedAt`
- `staleness` — `fresh` (< 5 min), `little_stale` (< 1 h), or `stale`; tune
  with `STALE_LITTLE_SECONDS` / `STALE_SECONDS`. Claude/Codex accounts use
  45 min / 3 h instead (`ACCOUNT_STALE_LITTLE_SECONDS` /
  `ACCOUNT_STALE_SECONDS`), since idle accounts are checked every 30 min.
  Clients should use this rather than their own age rules.
- `error` — null when the latest poll succeeded
- `intervalSec` — current polling interval (self-tunes)
- `nextFetchAt` — when the next refresh fires
- Claude/Codex accounts also have `dataSource` (`passive` | `active`),
  `observedAt` (latest CPA header observation) and `activeFetchedAt` (latest
  successful usage-endpoint check); see below.

Codex usage exposes semantic `five_hour`, `one_day` and `seven_day` windows,
each filed by its length (`window_minutes`), never by OpenAI's raw slot: up to
12 h is `five_hour`, up to 3 days `one_day`, longer `seven_day`. Any of them may
be `null` when OpenAI is not reporting that limit; `one_day` usually is. Each
window carries pacing (`expected_percent` /
`slack`) over its own length. The deprecated `primary` and `secondary` fields
remain as compatibility aliases for `five_hour` and `seven_day`; they do not
mirror OpenAI's variable raw slot positions, and the 24-hour window is only in
`one_day`. Results saved before `one_day` existed are re-filed by length when
served, so no extra upstream check is needed.

Claude usage also has `five_hour` (`utilization`, `resets_at`, plus pacing
`expected_percent` / `slack` over a 5-hour window). Only some Claude accounts
have a 5-hour limit, so it is `null` for accounts without one, while no session
is open, and once its reset time has passed; never read `null` as 0%.

Claude `reset_credits` splits its `available_count` by the limit each reset
clears, read from the grant's own `clears` list: `weekly_available` (clears the
account-wide weekly limit, `seven_day`), `fable_available` (clears only the Fable
weekly limit, `seven_day_overage_included`) and `other_available` (a kind not
recognized yet; logged once per grant). Each entry in `credits` carries the
same `type`, plus `grant_id`, `clears` and Anthropic's `usable_now`. Codex has
one count, as before.

## Subscription renewal dates

Each Claude/Codex account can carry a manually entered next billing date.
`/api/usage` account entries, the dashboard cards, and the MCP's
`list_accounts` / `get_usage` include:

```json
"renewal": { "renews_at": "2026-11-10", "billing_cycle": "monthly", "days_until_renewal": 7, "source": "manual" }
```

`renewal` is `null` when no date is set. Dates are calendar dates in
`America/Chicago` (`RENEWAL_TIME_ZONE`). Once a stored date passes, output rolls
it forward by whole monthly or yearly cycles. The stored anchor is left unchanged, so a
31st renewal returns to the 31st after short months.

Settings live in `usage-renewals.json` beside the history file
(`/home/node/data` in Dokploy; override with `USAGE_RENEWALS_FILE`), keyed by
account key. Hand edits are picked up on the next request. Set or update one
with the MCP owner key:

```bash
curl -X PUT https://usage.etdofresh.com/api/renewals/codex \
  -H "Authorization: Bearer $USAGE_MCP_OWNER_KEY" -H "Content-Type: application/json" \
  -d '{"renews_at":"2026-12-10","billing_cycle":"monthly"}'
curl -X DELETE https://usage.etdofresh.com/api/renewals/codex -H "Authorization: Bearer $USAGE_MCP_OWNER_KEY"
curl https://usage.etdofresh.com/api/renewals      # public, read-only
```

Without `USAGE_MCP_OWNER_KEY`, edits return 503. On first start, the current
dates for claude, claude3, claude4, codex, codex2 and codex3 are added only for
keys absent from the file. A `DELETE` stores `null`, so seeding never
restores a cleared date. The MCP stays read-only and cannot change these dates.

## MCP (read-only, owner-only)

`https://usage.etdofresh.com/mcp` is a stateless Streamable HTTP MCP server for
Claude / Duet custom connectors. It reads the same in-memory snapshot as
`/api/usage` and has no write tools: it cannot pause accounts, spend reset
credits or change CLIProxyAPI.

| Tool | What it returns |
| --- | --- |
| `list_accounts(provider?)` | Each Claude/Codex account: weekly %, reset time, pace (`weekly` is `null` for an account with no weekly limit), 5-hour window (Codex, and Claude accounts that have one; `null` otherwise), 24-hour window (`one_day`, Codex only; `null` where there is none), reset-credit count (read-only; Claude also split into weekly/Fable/other), freshness, proxy status; accounts paused on the proxy; other providers with data |
| `get_usage(account)` | Full detail for one key (`claude3`, `codex`, `zai`, ...) |
| `suggest_account(provider?)` | Accounts ranked by room for more work (blocked last); an account with no weekly limit is ranked by its 24-hour window (`ranked_by`) |
| `usage_history(account, days?, granularity?)` | Weekly (and 5-hour / 24-hour, where the account has them) % over time |
| `recent_requests(hours?)` | Per-account request/error/token counts from CPA Manager, plus the latest 20 requests |

Sign-in uses the single-owner OAuth module shared with imessage-mcp and
memory-database (`oauth/`), with endpoints under `/mcp/oauth` and scope
`usage.read`. Consent requires `USAGE_MCP_OWNER_KEY`; a copy is kept at
`~/.secrets/usage-mcp-owner-key` (0600) on etzminisforumx1pro. Grants and token
hashes live in `mcp-oauth.db` on the `usage-api-data` volume. Without the key
the MCP is off and `/mcp` returns 503. Connector URL:
`https://usage.etdofresh.com/mcp` (client ID blank, or `usage-claude`).

Per-account counts in `recent_requests` come from CPA Manager's
`account_snapshot`; they are only served behind OAuth. The public
`/api/recent` still omits account identities.

## Adaptive polling

Active Claude and Codex connections are discovered in the configured source every 30 seconds.
Existing primary/secondary environment mappings retain `claude`, `claude2`,
`codex`, and `codex2`; further accounts receive `claude3`, `codex3`, etc.
Numbers are persisted in `usage-accounts.json` beside the history file, so
account order changes do not mix usage history. Removed/disabled connections
stop polling and disappear. Each snapshot includes `account.id`, `account.name`,
`account.family`, and `account.priority` (CLIProxyAPI's routing priority, re-read
every 30 s; `null` when unset or when accounts come from 9router); clients can use
the ID to persist visibility preferences.
The website supports all account cards and history series automatically.

### Claude/Codex accounts: passive first, active as backup

CLIProxyAPI keeps the rate-limit headers from each account's latest real
request (`quota.signals` / `quota.observed_at` in `/v0/management/auth-files`),
which usage-api already reads every 30 s for account discovery. Anthropic's
`anthropic-ratelimit-unified-{7d,5h}-*` and OpenAI's `x-codex-{primary,secondary}-*`
headers carry the account's current weekly (and 5-hour) usage, so these
numbers are used whenever they are newer than the last active check
(`dataSource: "passive"`). Codex windows are classified by
`window-minutes`, not header slot (promax reports its weekly window as
`primary`). Codex headers are only read as the account's limits when
`x-codex-active-limit` is `premium` (or absent). An image request reports
`imagegen_premium` and the 24-hour image quota instead; those headers are
ignored, and the account keeps its last active check (they also do not slow the
backup checks down). On 2026-11-03 such headers had briefly replaced the promax
account's weekly window with the image quota. Claude headers for an account with no 5-hour limit (or that
has hit its weekly limit) carry no `5h` fields; the last active check's
`five_hour` is kept then. Headers round down, so within the same window the higher of the
passive and last active value is shown.

Headers do not carry Fable/Design windows, Spark, Claude plan labels or reset
credits; those come from the active check (`/api/oauth/usage`,
`/backend-api/wham/usage`), which is now a slow backup:

- every 60 min (`ACCOUNT_BUSY_SECONDS`) while passive data is < 30 min old
  (`ACCOUNT_PASSIVE_FRESH_SECONDS`), every 30 min (`ACCOUNT_IDLE_SECONDS`)
  otherwise, to catch use outside CPA
- once, 90 s after any known window reset (`ACCOUNT_AFTER_RESET_SECONDS`),
  except Claude's 5-hour window: it rolls several times a day and a reset only
  means no session is open, so it is shown as `null` without a check
- on 429: 15 min doubling up to 6 h (`ACCOUNT_429_BASE_SECONDS` /
  `ACCOUNT_429_MAX_SECONDS`), never sooner than `Retry-After`, and the normal
  cadence only resumes after a success; other errors back off from 2 min
- on restart, an account whose saved data is recent waits for its normal
  cadence instead of being re-checked immediately; first checks are staggered
- Codex reset-credit detail is re-read only when the summary count changes or
  every 3 h (`CODEX_RESET_CREDITS_SECONDS`); the Claude plan label every 12 h

Z.ai, OpenRouter, OpenAI and Jev each run an independent `Poller`:

- starts at `POLL_TARGET_SECONDS` (default 2.5 min)
- after 3 consecutive successes, walks toward `POLL_FLOOR_SECONDS` (1 min)
- on 429 with `Retry-After`: retries exactly then (+1 s), even past the
  ceiling, then resumes the normal interval; without it, doubles
- on other errors: doubles, capped at `POLL_CEILING_SECONDS` (10 min)

usage-api is the only service that polls provider usage endpoints. 9gate,
codex-remote, and Usage Monitor read `/api/usage`, so they share one set of
rate limits.

## Auth

API keys load from the shared `/home/node/workspace/.env` on startup. Override
the path with `SHARED_ENV_FILE`. Existing `process.env` values win, so Dokploy
env vars still override the file.

| Provider     | Source                                                  |
|--------------|---------------------------------------------------------|
| Claude Max   | 9router `claude` connection (named via `NINEROUTER_CLAUDE_ACCOUNT`, or auto-picked if only one exists) |
| Claude Max #2 (optional) | 9router `claude` connection matching `NINEROUTER_CLAUDE2_ACCOUNT` |
| Codex        | 9router `codex` connection matching `NINEROUTER_CODEX_ACCOUNT` |
| Codex #2 (optional) | 9router `codex` connection matching `NINEROUTER_CODEX2_ACCOUNT` |
| Z.ai         | `ZAI_API_KEY` env                                       |
| OpenRouter   | `OPENROUTER_API_KEY` env                                |
| Jev spend    | `OPENROUTER_MANAGEMENT_KEY` env                          |
| OpenAI       | `OPENAI_ADMIN_KEY` env                                  |

### 9router source for Claude/Codex

`src/providers/ninerouter.ts` reads 9router's SQLite connection store and
returns the access token it currently holds for an account. Nothing else is
taken from 9router; the usage numbers come from the providers themselves:

- Claude: `GET https://api.anthropic.com/api/oauth/usage`, the same endpoint
  Claude Code calls. Per-model weekly limits (Fable) arrive as
  `weekly_scoped` entries in `limits[]`, which is a genuinely different
  figure from the account-wide weekly window.
- Codex: `GET https://chatgpt.com/backend-api/wham/usage`. Five-hour vs.
  seven-day is decided by `limit_window_seconds`, never by slot order —
  OpenAI routinely puts a seven-day window in `primary_window` with
  `secondary_window` null.
- Claude's subscription tier needs a second call to
  `api/oauth/profile`, since the usage payload carries no tier at all. It is
  cached for 30 minutes because the tier changes about never.

Deliberately *not* read: 9router's own `/api/usage/<connectionId>`. It maps
OpenAI's positional window slots to names like `session` and drops
`limit_window_seconds`, so a seven-day window at 100% would be reported as a
five-hour one with nothing left in the payload to catch the error.

The database is opened read-only, which SQLite's WAL mode permits from a
separate process without disturbing 9router.

Required env var:

```
NINEROUTER_DB_PATH=/mnt/9router/data.sqlite   # default shown
```

On the Dokploy host this is a read-only bind mount of `~/.9router/db`.

Optional account-selection overrides (only needed when 9router has more than
one connection per provider, or the defaults below don't match). An account
is named by whichever identifier 9router records for it — Codex connections
carry an email, Claude ones may only have a display name:

```
NINEROUTER_CLAUDE_ACCOUNT=      # unset = auto-pick the sole "claude" connection
NINEROUTER_CLAUDE2_ACCOUNT=     # unset = claude2 stays disabled
NINEROUTER_CODEX_ACCOUNT=etdofresh@gmail.com
NINEROUTER_CODEX2_ACCOUNT=etdofresh+dev@gmail.com
```

`CLAUDE2_ENABLED=false` / `CODEX2_ENABLED=false` still work as hard kill
switches, same as before.

### Second Claude account

A second Claude account is opt-in. At startup the server reads 9router's
connections and checks for a `claude` one matching
`NINEROUTER_CLAUDE2_ACCOUNT`:

- A matching connection exists in 9router → a `claude2` poller runs and `/api/usage`
  includes a `claude2` key right after `claude`, same shape. The dashboard
  shows a "claude #2" card and "Claude #2 …" history series.
- `NINEROUTER_CLAUDE2_ACCOUNT` unset, or no matching 9router connection → the `claude2` key is entirely absent from the response (not
  null, not an error) and nothing about a second account appears in the UI.
- `CLAUDE2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch: the account is
  fully disabled and absent even when a matching 9router connection exists. Use this to
  turn the second account off from the environment without removing the connection.

### Second Codex account

A second Codex account is opt-in and never shares tokens or usage totals with
the primary account. At startup the server checks 9router for a `codex`
connection matching `NINEROUTER_CODEX2_ACCOUNT` (default `etdofresh+dev@gmail.com`):

- A matching connection exists in 9router → `/api/usage` includes a
  separate `codex2` provider and the dashboard labels both Codex accounts.
- No matching 9router connection → `codex2` is absent from the API, dashboard, and monitor.
- `CODEX2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch.

## Run locally

```bash
npm install
cp .env.example .env   # edit
npm run dev
curl http://localhost:3000/api/usage
```

## Dokploy

App: `usage-api`
Domain: `usage.etdofresh.com`
Mounts:

- `usage-api-auth`, previously mounted at `/home/node/auth` — **no longer
  used.** The image no longer declares this path as a volume and nothing in
  the app reads or writes it now that Claude/Codex go through 9router.
  Dokploy's own mount config for this volume can be removed at any time;
  leaving it in place is harmless (the container just gets an empty,
  ignored mount).
- `usage-api-data` mounted at `/home/node/data` for usage history
- `~/.9router/db` bind-mounted **read-only** at `/mnt/9router`, so the app
  can read the access token 9router keeps refreshed. Read-only is enough:
  SQLite's WAL mode lets a separate process read a live database without
  disturbing the writer.

### Renewing OAuth credentials (moved to 9router)

This container used to bundle the Claude Code and Codex CLIs and a
`usage-auth status|claude|claude2|codex|codex2` helper script so its own
Dokploy terminal could renew the OAuth files it read directly. Both are
removed: Claude/Codex accounts live entirely in 9router, and renewing them
is 9router's job (its Providers page, or the OAuth flows behind it). This
also dropped the slowest, most failure-prone layer of this image's build —
the global `npm install -g` of both CLIs.

If a token ever goes stale, the symptom is an `anthropic oauth/usage HTTP
401` or `codex usage HTTP 401` in the poller's error field; re-authorising
that connection in 9router is the fix, and the next poll picks the new token
up on its own.

## OpenRouter account credits and trailing spending

OpenRouter retains the configured key's `usage`, `limit` and `limit_remaining`. It additionally reads `/api/v1/credits` for `credits_balance` (USD account credits minus account usage). If `OPENROUTER_MANAGEMENT_KEY` is configured, analytics provides `spend_7d` for the exact rolling seven-day `spend_start`/`spend_end` period. Account balance and spending are independent from API-key usage/allowance. Missing/denied/malformed/truncated financial data is null, with `balance_error` / `spend_error`; it is not reported as zero and does not discard a successful key read. Requests use bounded timeouts.

The financial tests use mocked provider responses and do not query real accounts. This change is prepared on a branch because pushing production main auto-deploys this service.

## ETbot analytics

The owner-only `list_accounts` result includes optional `analytics.ranges`
(1, 7, 30 days; UTC hourly/daily buckets) from CPA Manager's persisted
monitoring analytics, using the existing server-side CPA_MANAGER configuration.
No events, account identities or credentials are forwarded by this adapter.
Costs are CPA rate-table estimates, not billed subscription spending. Pricing
coverage is unknown unless an active zero-priced model proves it incomplete;
in that case aggregate/chart costs are known priced subtotals, excluding
unpriced activity; if no active model has a positive known estimate, cost is null. Source retention is unknown unless
CPA explicitly reports partial coverage. Missing values remain null. This does
not reconstruct requests that CPA never recorded. Reads cache for 60 seconds
and share an in-flight background refresh; initial reads may have no analytics. Analytics failures leave quotas available.

Video parity follow-up: ranges also include 90 days. Provider totals come from
CPA channel_share and hourly/daily provider series from credential_timeline,
pooled server-side by auth_provider_snapshot; no credential/account identifiers
are forwarded. Unpriced request counts identify active model rows with no
positive estimate; zero may mean an unknown rate or a free model, so this is
conservative. Cache savings and cost-by-type/speed are explicitly unavailable:
this deployed source does not report those amounts, and no rates are invented.
