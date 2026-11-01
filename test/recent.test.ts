import assert from "node:assert/strict";
import test from "node:test";
import { RecentRequests, parseRecentExchanges, parseAccountActivity } from "../src/recent.js";

test("recent requests are bounded, newest first, and exclude credentials and private metadata", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ timestamp_ms: 1700000000000 + i,
    model: "gpt-6.1-sol", resolved_model: "gpt-6.1-sol", reasoning_effort: "high", failed: i === 24,
    access_token_sha256: "private", api_key_hash: "private", account_snapshot: "private", client_ip: "private" }));
  const rows = parseRecentExchanges({ events: { items } });
  assert.equal(rows.length, 20);
  assert.equal(rows[0].outcome, "error");
  assert.equal(rows[0].jev.effort, "high");
  assert.ok(rows[0].startedAt > rows[19].startedAt);
  assert.ok(!JSON.stringify(rows).includes("private"));
});

test("monitor requests share the same short-lived history cache", async () => {
  let count = 0;
  const recent = new RecentRequests("http://manager", "secret", (async (_url, init) => {
    count++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.include.events_page.limit, 20);
    return new Response(JSON.stringify({ events: { items: [] } }));
  }) as typeof fetch);
  await Promise.all([recent.get(), recent.get()]);
  await recent.get();
  assert.equal(count, 1);
});

test("account activity counts requests per account without private fields", () => {
  const items = [
    { timestamp_ms: 1700000000000, model: "m1", account_snapshot: "A@x.com", auth_provider_snapshot: "claude", failed: false, total_tokens: 10, access_token_sha256: "private", client_ip: "private" },
    { timestamp_ms: 1700000001000, model: "m2", account_snapshot: "a@x.com", auth_provider_snapshot: "claude", failed: true, total_tokens: 5 },
    { timestamp_ms: 1700000002000, model: "m1" },
  ];
  const s = parseAccountActivity({ events: { items, total_count: 7 } }, 24);
  assert.equal(s.total_in_window, 7);
  assert.equal(s.counted, 3);
  assert.deepEqual(s.by_account["a@x.com"], { provider: "claude", requests: 2, errors: 1, total_tokens: 15,
    last_at: new Date(1700000001000).toISOString(), models: { m1: 1, m2: 1 } });
  assert.equal(s.by_account.unknown.requests, 1);
  assert.ok(!JSON.stringify(s).includes("private"));
});
