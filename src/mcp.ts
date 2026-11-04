// Read-only MCP endpoint at /mcp, behind the same single-owner OAuth that
// imessage-mcp and memory-database use. Consent needs USAGE_MCP_OWNER_KEY.
// Without that key the MCP stays off and /mcp answers 503; /api/* is unaffected.
import express from "express";
import { rateLimit } from "express-rate-limit";
import { mcpAuthRouter, mcpAuthMetadataRouter, createOAuthMetadata } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { revocationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/revoke.js";
import { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { installOAuth, defaultConsentPage, defaultGrantTtl, claudeRedirects } from "../oauth/oauth.mjs";
import { OAuthStore } from "../oauth/oauth-store.mjs";
import { tools, callTool, SCOPE, type ToolContext } from "./mcp-tools.js";

export const CLAUDE_CLIENT_ID = "usage-claude";
// ET Bot (etbot.etdofresh.com) names itself by its client metadata URL. It is pre-registered with its
// one exact callback, so the document is never fetched and no other ET Bot callback is accepted.
export const ETBOT_CLIENT = { client_id: "https://etbot.etdofresh.com/oauth/client-metadata.json", client_name: "ET Bot", redirect_uris: ["https://etbot.etdofresh.com/api/connectors/oauth/callback"] };
export const OAUTH_PATH = "/mcp/oauth";
const VERSION = "0.1.0";

const deps = {
  express, rateLimit, mcpAuthRouter, mcpAuthMetadataRouter, createOAuthMetadata,
  handlers: { authorizationHandler, tokenHandler, revocationHandler },
  errors: { InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError },
};

const consent = {
  title: "Authorize usage-api MCP",
  describe: () => `<p>Grants the <strong>${SCOPE}</strong> scope: read ET's Claude and Codex account usage (weekly %, resets, pace, recent proxy requests) from usage-api.</p><p>Read-only: it cannot pause accounts, use reset credits or change anything.</p>`,
  ownerKeyLabel: "usage-api MCP owner key",
  ownerKeyNote: "Enter the usage-api MCP owner key here. It is never forwarded to the connecting application.",
  allowLabel: () => "Authorize usage reading",
};

const INSTRUCTIONS = "Read-only view of ET's AI account usage from usage-api. Use list_accounts for the overview and suggest_account to pick which Claude or Codex account has room for more work. Most accounts have a weekly limit; Codex and some Claude accounts also have a 5-hour window (five_hour is null where there is none), and some Codex accounts have a 24-hour window (one_day), which can stand in for the weekly limit (weekly is then null). Nothing here changes accounts.";

export interface McpOptions extends ToolContext {
  ownerKey?: string;
  publicOrigin?: string;
  store?: InstanceType<typeof OAuthStore>;
  grantTtl?: number;
  fetchClientMetadata?: typeof fetch;
  log?: (entry: Record<string, unknown>) => void;
}

export function installMcp(app: express.Express, opts: McpOptions) {
  const publicOrigin = opts.publicOrigin ?? "https://usage.etdofresh.com";
  const log = opts.log ?? ((entry) => console.log(JSON.stringify(entry)));
  if (!opts.ownerKey) {
    app.all(["/mcp", "/mcp/*"], (_req, res) => { res.status(503).json({ error: "MCP is not configured on this server" }); });
    return false;
  }
  const oauth = installOAuth(app as any, {
    deps, ownerKey: opts.ownerKey, origin: publicOrigin, oauthPath: OAUTH_PATH, scopes: [SCOPE], defaultScopes: [SCOPE],
    resourceName: "usage-api", firstParty: false, chatgpt: true, claude: true,
    clients: [{ client_id: CLAUDE_CLIENT_ID, client_name: "Claude", redirect_uris: claudeRedirects }, ETBOT_CLIENT],
    renderConsent: defaultConsentPage(consent), cookieName: "usage_oauth_csrf",
    store: opts.store ?? new OAuthStore(), grantTtl: opts.grantTtl ?? defaultGrantTtl,
    ...(opts.fetchClientMetadata ? { fetchClientMetadata: opts.fetchClientMetadata } : {}),
  });
  const noStore: express.RequestHandler = (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); };
  app.use("/mcp", noStore, (req: any, res, next) => {
    if (req.get("origin") && req.get("origin") !== publicOrigin) { res.status(403).json({ error: "Origin not allowed" }); return; }
    oauth(req, res, (err: unknown) => {
      if (err) return next(err);
      if (!req.auth?.scopes?.includes(SCOPE)) { res.status(403).json({ error: "insufficient_scope" }); return; }
      next();
    });
  });
  app.post("/mcp", express.json({ limit: "256kb" }), async (req: any, res) => {
    const actor = req.auth.clientId === CLAUDE_CLIENT_ID ? "claude" : String(req.auth.clientId).slice(0, 80);
    const server = new Server({ name: "usage-api", version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools as any }));
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      const started = Date.now();
      const result = await callTool(params.name, params.arguments, opts);
      log({ event: "mcp_tool_call", tool: params.name, actor, ok: !("isError" in result), ms: Date.now() - started });
      return result as any;
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }); }
  });
  app.all("/mcp", (_req, res) => { res.set("Allow", "POST").status(405).json({ error: "Use POST for stateless Streamable HTTP" }); });
  return true;
}
