import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { RenewalStore, ExpiryStore, installRenewals, nextRenewal, parseSetting, parseExpirySetting, providerExpiry, todayIn } from "../src/renewals.js";

test("future and same-day dates are kept; days_until_renewal counts calendar days", () => {
  assert.deepEqual(nextRenewal({ renews_at: "2026-11-10", billing_cycle: "monthly" }, "2026-11-03"),
    { renews_at: "2026-11-10", billing_cycle: "monthly", days_until_renewal: 7, source: "manual" });
  assert.equal(nextRenewal({ renews_at: "2026-11-03", billing_cycle: "monthly" }, "2026-11-03").days_until_renewal, 0);
});

test("passed dates roll forward by whole cycles from the stored anchor", () => {
  assert.equal(nextRenewal({ renews_at: "2026-11-10", billing_cycle: "monthly" }, "2026-11-11").renews_at, "2026-12-10");
  assert.equal(nextRenewal({ renews_at: "2026-11-10", billing_cycle: "monthly" }, "2027-02-11").renews_at, "2027-03-10");
  // Month-end anchors clamp in short months without drifting afterwards.
  assert.equal(nextRenewal({ renews_at: "2026-01-31", billing_cycle: "monthly" }, "2026-02-01").renews_at, "2026-02-28");
  assert.equal(nextRenewal({ renews_at: "2026-01-31", billing_cycle: "monthly" }, "2026-03-01").renews_at, "2026-03-31");
  assert.equal(nextRenewal({ renews_at: "2024-02-29", billing_cycle: "yearly" }, "2024-03-01").renews_at, "2025-02-28");
  assert.equal(nextRenewal({ renews_at: "2025-12-02", billing_cycle: "yearly" }, "2026-11-03").renews_at, "2026-12-02");
});

test("today is taken in America/Chicago", () => {
  // 03:00 UTC on Nov 10 is still Nov 9 in Chicago.
  assert.equal(todayIn("America/Chicago", Date.parse("2026-11-10T03:00:00Z")), "2026-11-09");
  const store = new RenewalStore(null);
  return store.set("codex", { renews_at: "2026-11-10", billing_cycle: "monthly" }).then(() => {
    assert.equal(store.get("codex", Date.parse("2026-11-10T03:00:00Z"))!.days_until_renewal, 1);
  });
});

test("parseSetting validates dates and defaults to monthly", () => {
  assert.deepEqual(parseSetting({ renews_at: "2026-12-02" }), { renews_at: "2026-12-02", billing_cycle: "monthly" });
  assert.equal(typeof parseSetting({ renews_at: "2026-02-30" }), "string");
  assert.equal(typeof parseSetting({ renews_at: "12/02/2026" }), "string");
  assert.equal(typeof parseSetting({ renews_at: "2026-12-02", billing_cycle: "weekly" }), "string");
});

test("seeds fill only missing keys and never overwrite edits or deletions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renewals-"));
  const file = path.join(dir, "usage-renewals.json");
  try {
    await writeFile(file, JSON.stringify({ codex: { renews_at: "2027-01-01", billing_cycle: "yearly" }, claude: null }));
    const store = new RenewalStore(file);
    await store.load({ codex: { renews_at: "2026-11-10", billing_cycle: "monthly" }, claude: { renews_at: "2026-12-02", billing_cycle: "monthly" }, codex2: { renews_at: "2026-11-12", billing_cycle: "monthly" } });
    const saved = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(saved, { codex: { renews_at: "2027-01-01", billing_cycle: "yearly" }, claude: null, codex2: { renews_at: "2026-11-12", billing_cycle: "monthly" } });
    assert.equal(store.get("claude"), null);
    assert.equal(store.get("claude9"), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("hand edits to the file are picked up without a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "renewals-"));
  const file = path.join(dir, "usage-renewals.json");
  try {
    const store = new RenewalStore(file);
    await store.load({ codex: { renews_at: "2026-11-10", billing_cycle: "monthly" } });
    const now = Date.parse("2026-11-03T15:00:00Z");
    assert.equal(store.get("codex", now)!.renews_at, "2026-11-10");
    await new Promise(r => setTimeout(r, 20));
    await writeFile(file, JSON.stringify({ codex: { renews_at: "2026-11-20" } }));
    assert.equal(store.get("codex", now)!.renews_at, "2026-11-20");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function start(ownerKey?: string) {
  const app = express();
  const store = new RenewalStore(null);
  await store.load({ codex: { renews_at: "2099-01-05", billing_cycle: "monthly" } });
  installRenewals(app, store, ownerKey);
  const server = await new Promise<any>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, close: async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
const put = (base: string, account: string, body: unknown, key?: string) => fetch(`${base}/api/renewals/${account}`, {
  method: "PUT", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

test("REST edits need the owner key", async () => {
  const s = await start("owner-fixture");
  try {
    assert.equal((await put(s.base, "claude3", { renews_at: "2099-01-27" })).status, 401);
    assert.equal((await put(s.base, "claude3", { renews_at: "2099-01-27" }, "wrong")).status, 401);
    assert.equal((await put(s.base, "zai", { renews_at: "2099-01-27" }, "owner-fixture")).status, 400);
    assert.equal((await put(s.base, "claude3", { renews_at: "soon" }, "owner-fixture")).status, 400);
    const ok = await put(s.base, "claude3", { renews_at: "2099-01-27", billing_cycle: "yearly" }, "owner-fixture");
    assert.equal(ok.status, 200);
    assert.deepEqual((await ok.json()).renewal, { renews_at: "2099-01-27", billing_cycle: "yearly", days_until_renewal: s.store.get("claude3")!.days_until_renewal, source: "manual" });
    const all = (await (await fetch(`${s.base}/api/renewals`)).json()).renewals;
    assert.deepEqual(Object.keys(all).sort(), ["claude3", "codex"]);
    const del = await fetch(`${s.base}/api/renewals/codex`, { method: "DELETE", headers: { authorization: "Bearer owner-fixture" } });
    assert.equal(del.status, 200);
    assert.equal(s.store.get("codex"), null);
  } finally { await s.close(); }
});

test("REST edits are off without an owner key", async () => {
  const s = await start();
  try {
    assert.equal((await put(s.base, "claude3", { renews_at: "2099-01-27" }, "anything")).status, 503);
    assert.equal((await fetch(`${s.base}/api/renewals`)).status, 200);
  } finally { await s.close(); }
});

test("provider expiry: only a plan that will not renew, as a Chicago calendar date", () => {
  const now = Date.parse("2026-11-13T18:00:00Z");
  // 06:15 UTC on Dec 9 is 00:15 on Dec 9 in Chicago.
  assert.deepEqual(providerExpiry({ status: "active", will_renew: false, expires_at: "2026-12-09T06:15:18.000Z" }, "America/Chicago", now),
    { expires_at: "2026-12-09", days_until_expiry: 26, source: "provider", ends_at: "2026-12-09T06:15:18.000Z" });
  assert.equal(providerExpiry({ status: "active", will_renew: true, expires_at: "2026-12-09T06:15:18Z" }, "America/Chicago", now), null);
  assert.equal(providerExpiry({ status: "active", will_renew: null, expires_at: null }, "America/Chicago", now), null);
  assert.equal(providerExpiry(null), null);
  // cancels_at wins over expires_at; an inactive plan reads as expired.
  assert.equal(providerExpiry({ status: "active", will_renew: true, cancels_at: "2026-11-20T12:00:00Z", expires_at: "2026-12-09T06:15:18Z" }, "America/Chicago", now)!.expires_at, "2026-11-20");
  assert.equal(providerExpiry({ status: "inactive", will_renew: false, expires_at: "2026-11-10T12:00:00Z" }, "America/Chicago", now)!.days_until_expiry, -3);
  // Claude only reports a status; nothing to date.
  assert.equal(providerExpiry({ status: "active", will_renew: null, expires_at: null, cancels_at: null }, "America/Chicago", now), null);
});

test("manual expiry is the fallback; a provider end date wins", async () => {
  const store = new ExpiryStore(null);
  const now = Date.parse("2026-11-13T18:00:00Z");
  assert.equal(store.get("claude3", now), null);
  await store.set("claude3", { expires_at: "2026-11-27" });
  assert.deepEqual(store.get("claude3", now), { expires_at: "2026-11-27", days_until_expiry: 14, source: "manual", ends_at: null });
  assert.deepEqual(store.resolve("claude3", { status: "active", will_renew: null, expires_at: null }, now), store.get("claude3", now));
  await store.set("codex2", { expires_at: "2026-12-31" });
  assert.equal(store.resolve("codex2", { status: "active", will_renew: false, expires_at: "2026-12-09T06:15:18Z" }, now)!.source, "provider");
  assert.equal(parseExpirySetting({ expires_at: "2026-02-30" }), "expires_at must be a YYYY-MM-DD date");
  assert.deepEqual(parseExpirySetting({ expires_at: "2026-12-01", extra: 1 }), { expires_at: "2026-12-01" });
});

test("manual expiry dates are kept in their own file and edited over REST with the owner key", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "expiries-"));
  const file = path.join(dir, "usage-expiries.json");
  const app = express();
  const expiries = new ExpiryStore(file);
  await expiries.load();
  installRenewals(app, new RenewalStore(null), "owner-fixture", expiries);
  const server = await new Promise<any>(r => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = (method: string, account: string, body?: unknown, key = "owner-fixture") => fetch(`${base}/api/expiries/${account}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    assert.equal((await send("PUT", "claude3", { expires_at: "2099-01-27" }, "wrong")).status, 401);
    assert.equal((await send("PUT", "claude3", { expires_at: "soon" })).status, 400);
    assert.equal((await send("PUT", "zai", { expires_at: "2099-01-27" })).status, 400);
    const put = await send("PUT", "claude3", { expires_at: "2099-01-27" });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).expiry.expires_at, "2099-01-27");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { claude3: { expires_at: "2099-01-27" } });
    assert.equal((await (await fetch(`${base}/api/expiries`)).json()).expiries.claude3.source, "manual");
    assert.equal((await send("DELETE", "claude3")).status, 200);
    assert.equal(expiries.get("claude3"), null);
  } finally {
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await rm(dir, { recursive: true, force: true });
  }
});
