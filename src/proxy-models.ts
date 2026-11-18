// MCP list_models: a fresh GET /v1/models against CLIProxyAPI on every call (nothing cached).
// /v1/models accepts only a client API key from CPA's access.api-keys (not the management key),
// so this needs CLIPROXYAPI_CLIENT_KEY; without it the tool reports that it is not configured.

export interface ProxyModel { id: string; object?: string; owned_by?: string; type?: string; created?: number }
export interface ProxyModelList { models: ProxyModel[]; count: number; fetched_at: string }

export class ProxyModelsError extends Error {
  constructor(readonly code: "unavailable" | "proxy_error", message: string) { super(message); }
}

export async function fetchProxyModels(baseUrl: string, key: string | undefined,
  fetcher: typeof fetch = fetch, now: () => number = Date.now): Promise<ProxyModelList> {
  if (!key) throw new ProxyModelsError("unavailable", "list_models is not configured: usage-api has no CLIProxyAPI client API key (CLIPROXYAPI_CLIENT_KEY).");
  const redact = (text: string) => text.split(key).join("[redacted]");
  let response: Response;
  try {
    response = await fetcher(`${baseUrl.replace(/\/$/, "")}/v1/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new ProxyModelsError("proxy_error", `CLIProxyAPI /v1/models ${reason}.`);
  }
  let body: any = null;
  try { body = await response.json(); } catch { /* non-JSON */ }
  if (!response.ok) {
    const raw = body?.error?.message ?? body?.error ?? body?.message;
    const detail = typeof raw === "string" ? `: ${redact(raw).slice(0, 200)}` : "";
    throw new ProxyModelsError("proxy_error", `CLIProxyAPI /v1/models HTTP ${response.status}${detail}`);
  }
  const items = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : null;
  if (!items) throw new ProxyModelsError("proxy_error", "CLIProxyAPI /v1/models returned an unexpected shape.");
  const str = (v: unknown) => (typeof v === "string" && v ? redact(v).slice(0, 200) : undefined);
  const models: ProxyModel[] = [];
  for (const m of items) {
    const id = str(m?.id);
    if (!id) continue;
    models.push({ id,
      ...(str(m.object) ? { object: str(m.object) } : {}),
      ...(str(m.owned_by) ? { owned_by: str(m.owned_by) } : {}),
      ...(str(m.type) ? { type: str(m.type) } : {}),
      ...(typeof m.created === "number" && Number.isFinite(m.created) ? { created: m.created } : {}) });
  }
  return { models, count: models.length, fetched_at: new Date(now()).toISOString() };
}
