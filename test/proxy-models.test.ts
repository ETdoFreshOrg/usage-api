import assert from "node:assert/strict";
import test from "node:test";
import { fetchProxyModels, ProxyModelsError } from "../src/proxy-models.js";

const KEY = "cpa-client-fixture-secret";
const NOW = Date.parse("2026-11-18T04:00:00Z");
function fake(status: number, body: unknown) {
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  const fetcher = (async (url: any, init: any) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null, method: init?.method ?? "GET" });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

test("list_models does a fresh authenticated GET /v1/models each call and keeps only plain fields", async () => {
  const { fetcher, calls } = fake(200, { object: "list", data: [
    { id: "claude-opus-5-5", object: "model", owned_by: "anthropic", type: "claude", created: 1790000000, secret: KEY },
    { id: "gpt-6.1-sol", object: "model", owned_by: "openai" }, { owned_by: "nobody" }] });
  const a = await fetchProxyModels("http://proxy:8317/", KEY, fetcher, () => NOW);
  const b = await fetchProxyModels("http://proxy:8317/", KEY, fetcher, () => NOW);
  assert.equal(calls.length, 2, "no caching between calls");
  assert.deepEqual(calls[0], { url: "http://proxy:8317/v1/models", auth: `Bearer ${KEY}`, method: "GET" });
  assert.equal(a.count, 2);
  assert.deepEqual(a.models.map(m => m.id), ["claude-opus-5-5", "gpt-6.1-sol"]);
  assert.deepEqual(a.models[0], { id: "claude-opus-5-5", object: "model", owned_by: "anthropic", type: "claude", created: 1790000000 });
  assert.equal(a.fetched_at, "2026-11-18T04:00:00.000Z");
  assert.ok(!JSON.stringify([a, b]).includes(KEY));
});

test("list_models without a client key says it is not configured and calls nothing", async () => {
  const { fetcher, calls } = fake(200, { data: [] });
  await assert.rejects(fetchProxyModels("http://proxy", undefined, fetcher), (e: any) => e instanceof ProxyModelsError && e.code === "unavailable" && /CLIPROXYAPI_CLIENT_KEY/.test(e.message));
  assert.equal(calls.length, 0);
});

test("list_models errors carry the status but never the key", async () => {
  for (const [status, body] of [[401, { error: { message: `invalid api key ${KEY}` } }], [500, "<html>oops</html>"], [200, { nope: 1 }]] as const) {
    const { fetcher } = fake(status, body);
    await assert.rejects(fetchProxyModels("http://proxy", KEY, fetcher), (e: any) => e.code === "proxy_error" && !e.message.includes(KEY)
      && (status === 200 ? /unexpected shape/.test(e.message) : e.message.includes(`HTTP ${status}`)));
  }
  const down = (async () => { throw Object.assign(new Error(`connect ECONNREFUSED with ${KEY}`), { name: "TypeError" }); }) as typeof fetch;
  await assert.rejects(fetchProxyModels("http://proxy", KEY, down), (e: any) => e.code === "proxy_error" && !e.message.includes(KEY) && /could not be reached/.test(e.message));
});
