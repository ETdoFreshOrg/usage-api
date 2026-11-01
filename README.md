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
- `fetchedAt` — ISO date-time of the fetch that produced `data`
- `lastAttemptAt` — ISO date-time of the latest poll, success or failure
- `ageSec` — seconds since `fetchedAt`
- `staleness` — `fresh` (< 5 min), `little_stale` (< 1 h), or `stale`; tune
  with `STALE_LITTLE_SECONDS` / `STALE_SECONDS`. Clients should use this
  rather than their own age rules.
- `error` — null when the latest poll succeeded
- `intervalSec` — current polling interval (self-tunes)
- `nextFetchAt` — when the next refresh fires

Codex usage exposes semantic `five_hour` and `seven_day` windows. Either may be
`null` when OpenAI is not reporting that limit. The deprecated `primary` and
`secondary` fields remain as compatibility aliases for `five_hour` and
`seven_day`; they do not mirror OpenAI's variable raw slot positions.

## MCP (read-only, owner-only)

`https://usage.etdofresh.com/mcp` is a stateless Streamable HTTP MCP server for
Claude / Duet custom connectors. It reads the same in-memory snapshot as
`/api/usage` and has no write tools: it cannot pause accounts, spend reset
credits or change CLIProxyAPI.

| Tool | What it returns |
| --- | --- |
| `list_accounts(provider?)` | Each Claude/Codex account: weekly %, reset time, pace, Codex 5-hour window, reset-credit count (read-only), freshness, proxy status; accounts paused on the proxy; other providers with data |
| `get_usage(account)` | Full detail for one key (`claude3`, `codex`, `zai`, ...) |
| `suggest_account(provider?)` | Accounts ranked by room for more work (blocked last) |
| `usage_history(account, days?, granularity?)` | Weekly (and Codex 5-hour) % over time |
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
and `account.family`; clients can use the ID to persist visibility preferences.
The website supports all account cards and history series automatically.

Each provider runs an independent `Poller`:

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
