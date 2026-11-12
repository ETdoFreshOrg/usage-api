import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("history records enriched provider data so expected_percent is persisted", () => {
  assert.match(server, /function enrichProviderData\(provider: string, data: unknown\)/);
  assert.match(server, /const enriched = enrichProviderData\(provider, data\)/);
  assert.match(server, /history\.recordProvider\(provider, enriched, fetchedAt, options\)/);
});

test("Codex history omits deprecated aliases to avoid duplicate series", () => {
  assert.match(server, /primary: _primary, secondary: _secondary/);
  assert.match(server, /primary: _p, secondary: _s/);
  assert.match(server, /history\.recordProvider\(provider, codexData, fetchedAt, options\)/);
});

test("optional second Codex account uses an isolated poller and provider key", () => {
  // The second account is named by whichever identifier 9router records for
  // it, and only starts when 9router actually has that connection.
  assert.match(server, /key === "codex2" && CODEX2_OFF/);
  assert.match(server, /new AccountPoller\(key, family/);
  assert.match(server, /providers\[key\] =/);
});

test("pacing constants exist before the first account sync can record passive history", () => {
  assert.ok(server.indexOf("const SEVEN_DAY_MS") < server.indexOf("await syncAccounts();"));
  assert.ok(server.indexOf("const ACCOUNT_HISTORY_UNCHANGED_MS") < server.indexOf("await syncAccounts();"));
});
