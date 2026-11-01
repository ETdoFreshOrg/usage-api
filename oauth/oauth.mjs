// Copied from ETdoFreshOrg/imessage-mcp server/oauth (same single-owner OAuth module).
// Only change: the pasted owner key is trimmed, so a stray space or newline from copying doesn't deny consent.
// Copied unchanged from ETdoFreshOrg/memory-database mcp/oauth/oauth.mjs (commit bf1959f),
// which took it from ETdoFreshOrg/etcode services/mcp-oauth.
// Shared single-owner OAuth 2.1 authorization + resource server for ETcode MCP services.
// Extracted from services/mcp-gateway/oauth.mjs. Each service supplies its scopes,
// consent wording, resource name and pre-registered clients; the protocol, PKCE,
// token lifetimes, refresh rotation, persistence and consent checks are identical.
//
// This module imports only Node built-ins. Third-party code (express,
// express-rate-limit and the MCP SDK auth router) is passed in as `deps` by the
// consuming service, so each service resolves its own pinned node_modules and keeps
// its own Docker image self-contained.
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {OAuthStore} from './oauth-store.mjs';
const random=()=>randomBytes(32).toString('base64url');
const hash=x=>createHash('sha256').update(x).digest('hex');
const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
export const escape=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const chatgptStableClient='https://chatgpt.com/oauth/client.json';
const stableRedirect='https://chatgpt.com/connector_platform_oauth_redirect';
export const claudeRedirects=['https://claude.ai/api/mcp/auth_callback','https://claude.com/api/mcp/auth_callback'];
// Claude's client ID metadata documents (used when no client ID is entered in the connector).
export const claudeMetadataClients=['https://claude.ai/oauth/mcp-oauth-client-metadata','https://claude.com/oauth/mcp-oauth-client-metadata'];

const day=86400000;
export const defaultGrantTtl=30*day;

// Generic consent page for services that do not supply their own renderer.
// `consent` wording: {title, appName, describe(scopes)->html, ownerKeyLabel, ownerKeyNote, allowLabel(scopes)}.
export function defaultConsentPage(consent){
 return ({clientLabel,scopes,lifetime,redirectUri,requestId,consentPath='/consent'})=>`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(consent.title)}</title><style>body{font:18px system-ui;max-width:600px;margin:8vh auto;padding:24px;line-height:1.5}input,button{font:inherit;padding:10px;width:100%;box-sizing:border-box;margin:10px 0}.warn{border-left:4px solid #b45309;padding:4px 12px;background:#fff7ed}</style><h1>Authorize ${escape(clientLabel)}</h1>${consent.describe(scopes)}<p>Access tokens expire after 15 minutes. This permission lasts ${lifetime} and survives service restarts; reusing a refresh token revokes it.</p><p>Return address: ${escape(redirectUri)}</p><form method="post" action="${escape(consentPath)}"><input type="hidden" name="request" value="${requestId}"><label>${escape(consent.ownerKeyLabel)}<input type="password" name="owner_key" required autocomplete="off"></label><p>${escape(consent.ownerKeyNote)}</p><button name="decision" value="allow">${escape(consent.allowLabel(scopes))}</button><button name="decision" value="deny" formnovalidate>Cancel</button></form></html>`;
}

// Single-owner server. Only the OAuth control plane uses this state; no tool can
// access it. Short-lived consent requests and codes stay in memory. Grants and token
// hashes live in `store` (OAUTH_DB on the /data volume in production), so sign-ins
// survive restarts and redeploys until the grant itself expires.
//
// Options:
//  deps            {express, rateLimit, mcpAuthRouter, createOAuthMetadata, errors:{InvalidGrantError,InvalidScopeError,InvalidTargetError,InvalidTokenError}}
//                  With oauthPath also {mcpAuthMetadataRouter, handlers:{authorizationHandler,tokenHandler,revocationHandler}}.
//  oauthPath       '' (default) mounts /authorize, /token, /revoke and /consent at the root. A path such
//                  as '/mcp/oauth' mounts them under it, advertises those endpoints in the metadata,
//                  and keeps the root paths as aliases for clients that cached them.
//  ownerKey        consent secret; origin: public origin (issuer); resource is origin + resourcePath
//  scopes          supported scopes; defaultScopes: granted when a client requests none
//  resourceName    shown in protected-resource metadata
//  firstParty      expose origin/app/client.json + /app/callback (the gateway website)
//  chatgpt         accept ChatGPT client metadata documents at exact chatgpt.com paths
//  claude          accept Claude client metadata documents at exact claude.ai/claude.com paths
//  clients         pre-registered public clients [{client_id, client_name, redirect_uris}]
//  clientLabel     (client, builtins) -> consent heading name
//  renderConsent   ({client,clientLabel,scopes,lifetime,redirectUri,requestId,consentPath}) -> html
//  cookieName      consent CSRF cookie name
export function installOAuth(app,{deps,ownerKey,origin,resourcePath='/mcp',oauthPath='',scopes,defaultScopes=scopes?.slice(0,1),resourceName,firstParty:withFirstParty=false,chatgpt=true,claude=false,clients:preRegistered=[],clientLabel,renderConsent,cookieName='oauth_csrf',fetchClientMetadata=fetch,clock=()=>Date.now(),store=new OAuthStore(),grantTtl=defaultGrantTtl}={}) {
 if(!deps)throw new Error('installOAuth requires deps');
 if(!scopes?.length)throw new Error('installOAuth requires scopes');
 if(typeof renderConsent!=='function')throw new Error('installOAuth requires renderConsent');
 const {express,rateLimit,mcpAuthRouter,createOAuthMetadata,errors:{InvalidGrantError,InvalidScopeError,InvalidTargetError,InvalidTokenError}}=deps;
 const issuer=new URL(origin).href, resource=new URL(resourcePath,origin).href;
 const prefix=String(oauthPath||'').replace(/\/+$/,'');
 if(prefix&&!/^(\/[A-Za-z0-9._-]+)+$/.test(prefix))throw new Error('oauthPath must be a path such as /mcp/oauth');
 if(prefix&&(!deps.handlers||!deps.mcpAuthMetadataRouter))throw new Error('oauthPath requires deps.handlers and deps.mcpAuthMetadataRouter');
 // Each endpoint is served at its prefixed path (advertised) and at the root path (alias).
 const mounts=name=>prefix?[prefix+name,name]:[name];
 const plural=(n,unit)=>n+' '+unit+(n===1?'':'s'),lifetime=grantTtl%day?plural(Math.round(grantTtl/3600000),'hour'):plural(grantTtl/day,'day');
 const supportedScopes=[...scopes];
 const pending=new Map(),codes=new Map(),clients=new Map(),{access,refresh,grants}=store;
 const resourceCheck=value=>{if(value?.href!==resource)throw new InvalidTargetError('Resource must match the MCP endpoint');};
 const scopeCheck=value=>{if(value?.length&&value.some(s=>!supportedScopes.includes(s)))throw new InvalidScopeError('Requested scope is not permitted');};
 const prune=()=>{for(const map of [pending,codes])for(const [key,value] of map)if(value.expires<=clock())map.delete(key);store.prune(clock());};
 const remember=(map,key,value)=>{prune();if(map.size>=1000)throw new InvalidGrantError('Capacity reached');map.set(key,value);};
 // Allowed callbacks for a metadata-document client id, or undefined if the id is not one we fetch.
 const callbacks=id=>{
  if(claude&&claudeMetadataClients.includes(id))return {redirects:claudeRedirects,name:'Claude'};
  if(!chatgpt)return undefined;
  if(id===chatgptStableClient)return {redirects:[stableRedirect]};
  const m=/^https:\/\/chatgpt\.com\/oauth\/([A-Za-z0-9_-]{1,160})\/client\.json$/.exec(id);
  return m?{redirects:[`https://chatgpt.com/connector/oauth/${m[1]}`]}:undefined;
 };
 const base={token_endpoint_auth_method:'none',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:supportedScopes.join(' ')};
 // The optional first-party website client: exactly this origin's /app/client.json and /app/callback.
 // It is defined here, never fetched, and uses the same consent, scopes and lifetimes.
 const firstParty=withFirstParty?{client_id:new URL('/app/client.json',origin).href,redirect_uris:[new URL('/app/callback',origin).href],...base}:null;
 // Pre-registered public clients; exact callbacks only, no dynamic registration or metadata fetch.
 const registered=new Map(preRegistered.map(c=>[c.client_id,{...base,client_id:c.client_id,client_name:c.client_name,redirect_uris:[...c.redirect_uris]}]));
 const getClient=async id=>{
  if(firstParty&&id===firstParty.client_id)return firstParty;
  if(registered.has(id))return registered.get(id);
  const allowed=callbacks(id);if(!allowed)return undefined;
  const cached=clients.get(id);if(cached&&cached.expires>clock())return cached.client;
  try {
   // Exact ChatGPT and Claude paths only; no arbitrary URL fetches, redirects, or SSRF.
   const response=await fetchClientMetadata(id,{redirect:'error',signal:AbortSignal.timeout(5000)});
   if(!response.ok)return undefined;
   const text=await response.text();if(text.length>32768)return undefined;
   const data=JSON.parse(text);
   const methods=data.token_endpoint_auth_methods_supported||[data.token_endpoint_auth_method];
   const redirects=allowed.redirects.filter(r=>data.redirect_uris?.includes(r));
   if(data.client_id!==id||!redirects.length||!methods.includes('none'))return undefined;
   const client={client_id:id,redirect_uris:redirects,...base,...(allowed.name?{client_name:allowed.name}:{})};
   if(clients.size<1000)clients.set(id,{client,expires:clock()+300000});
   return client;
  } catch {return undefined;}
 };
 const labelOf=client=>clientLabel?clientLabel(client,{firstParty:firstParty?.client_id,registered:registered.has(client.client_id)}):(client.client_name||'ChatGPT');
 const issue=(client,grant)=>{
  if(grant.expires<=clock()||!grants.has(grant.id))throw new InvalidGrantError('Consent expired or revoked');
  const a=random(),r=random(),ttl=Math.min(900,Math.floor((grant.expires-clock())/1000));
  remember(access,hash(a),{clientId:client.client_id,grantId:grant.id,expires:clock()+ttl*1000});
  remember(refresh,hash(r),{clientId:client.client_id,grantId:grant.id,expires:grant.expires,used:false});
  return {access_token:a,token_type:'Bearer',expires_in:ttl,refresh_token:r,scope:grant.scopes.join(' ')};
 };
 const provider={
  clientsStore:{getClient},
  async authorize(client,params,res){
   resourceCheck(params.resource);scopeCheck(params.scopes);
   if(!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))throw new InvalidGrantError('Invalid S256 challenge');
   const id=random(),csrf=random();
   remember(pending,hash(id),{client,params,csrfHash:hash(csrf),expires:clock()+300000});
   // Consent posts back beside the authorize path the request used, so a root alias stays on root paths.
   const consentPath=res.locals?.oauthConsentPath||mounts('/consent')[0];
   res.cookie(cookieName,csrf,{httpOnly:true,secure:true,sameSite:'lax',path:consentPath,maxAge:300000});
   // Preserve Origin for same-origin consent; suppress cross-origin referrers.
   // The callback below has already passed the exact redirect allowlist.
   res.set('Referrer-Policy','same-origin');
   res.set('Content-Security-Policy',`default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${params.redirectUri}; frame-ancestors 'none'; base-uri 'none'`);
   res.type('html').send(renderConsent({client,clientLabel:labelOf(client),scopes:params.scopes,lifetime,redirectUri:params.redirectUri,requestId:id,consentPath}));
  },
  async challengeForAuthorizationCode(client,code){
   prune();const record=codes.get(hash(code));if(!record||record.client.client_id!==client.client_id)throw new InvalidGrantError('Code invalid or expired');return record.params.codeChallenge;
  },
  async exchangeAuthorizationCode(client,code,verifier,redirectUri,target){
   prune();const record=codes.get(hash(code));codes.delete(hash(code));
   if(!record||record.client.client_id!==client.client_id||redirectUri!==record.params.redirectUri)throw new InvalidGrantError('Code or redirect invalid');
   resourceCheck(target);
   // SDK token handler already validated the stored S256 PKCE challenge.
   const grant={id:random(),expires:clock()+grantTtl,scopes:record.params.scopes?.length?record.params.scopes:[...defaultScopes]};remember(grants,grant.id,grant);
   return issue(client,grant);
  },
  async exchangeRefreshToken(client,token,scopes,target){
   prune();const entry=refresh.get(hash(token));
   if(!entry||entry.clientId!==client.client_id)throw new InvalidGrantError('Refresh token invalid');
   if(entry.used){grants.delete(entry.grantId);throw new InvalidGrantError('Refresh reuse revoked consent');}
   resourceCheck(target);scopeCheck(scopes);
   const grant=grants.get(entry.grantId);if(!grant)throw new InvalidGrantError('Consent expired or revoked');
   if(scopes?.some(s=>!grant.scopes.includes(s)))throw new InvalidScopeError('Cannot expand consent');
   // Keep a used token only long enough to detect replay, so refreshes over a long
   // grant cannot exhaust the store.
   refresh.set(hash(token),{...entry,used:true,expires:Math.min(entry.expires,clock()+day)});return issue(client,grant);
  },
  async verifyAccessToken(token){
   prune();const entry=access.get(hash(token));
   if(!entry||!grants.has(entry.grantId))throw new InvalidTokenError('Access token expired or invalid');
   return {token,clientId:entry.clientId,scopes:grants.get(entry.grantId).scopes,expiresAt:Math.floor(entry.expires/1000),resource:new URL(resource)};
  },
  async revokeToken(client,request){
   const entry=access.get(hash(request.token))||refresh.get(hash(request.token));
   if(entry?.clientId===client.client_id)grants.delete(entry.grantId);
  }
 };
 const options={provider,issuerUrl:new URL(issuer),resourceServerUrl:new URL(resource),scopesSupported:supportedScopes,resourceName};
 const endpoint=name=>new URL(mounts(name)[0],issuer).href;
 const metadata={...createOAuthMetadata(options),authorization_endpoint:endpoint('/authorize'),token_endpoint:endpoint('/token'),revocation_endpoint:endpoint('/revoke'),client_id_metadata_document_supported:true,authorization_response_iss_parameter_supported:true,token_endpoint_auth_methods_supported:['none'],revocation_endpoint_auth_methods_supported:['none']};
 app.get('/.well-known/oauth-authorization-server',(req,res)=>res.json(metadata));
 app.get('/.well-known/oauth-protected-resource',(req,res)=>res.json({resource,authorization_servers:[issuer],scopes_supported:supportedScopes}));
 // The SDK emits redirects for validated clients, including errors. Add RFC 9207
 // issuer identification to every authorization response, not just successes.
 for(const path of mounts('/authorize'))app.use(path,(req,res,next)=>{
  res.locals.oauthConsentPath=path.slice(0,-'/authorize'.length)+'/consent';
  const original=res.redirect.bind(res);
  res.redirect=(status,url)=>{if(url===undefined){url=status;status=302;}const target=new URL(url);target.searchParams.set('iss',issuer);return original(status,target.href);};
  next();
 });
 if(!prefix)app.use(mcpAuthRouter(options));
 else {
  // Same SDK handlers as mcpAuthRouter, mounted at the prefixed paths and the root aliases.
  // One handler instance per endpoint, so both paths share its rate limit.
  const {authorizationHandler,tokenHandler,revocationHandler}=deps.handlers;
  const handler={'/authorize':authorizationHandler({provider}),'/token':tokenHandler({provider}),'/revoke':revocationHandler({provider})};
  for(const [name,h] of Object.entries(handler))for(const path of mounts(name))app.use(path,h);
  app.use(deps.mcpAuthMetadataRouter({oauthMetadata:metadata,resourceServerUrl:new URL(resource),scopesSupported:supportedScopes,resourceName}));
 }
 const consentLimit=rateLimit({windowMs:900000,limit:30,standardHeaders:true,legacyHeaders:false});
 for(const consentPath of mounts('/consent'))app.post(consentPath,consentLimit,express.urlencoded({extended:false,limit:'4kb'}),(req,res)=>{
  prune();const id=typeof req.body.request==='string'?req.body.request:'';
  const record=pending.get(hash(id));
  const cookie=(req.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.split('=')[1]||'';
  if(!record||!equal(hash(cookie),record.csrfHash)||req.get('origin')!==origin)return res.status(403).json({error:'Invalid or expired consent request'});
  if(req.body.decision!=='deny'&&(req.body.decision!=='allow'||!equal(String(req.body.owner_key||'').trim(),ownerKey)))return res.status(401).json({error:'Authorization denied'});
  pending.delete(hash(id));res.clearCookie(cookieName,{secure:true,httpOnly:true,sameSite:'lax',path:consentPath});
  const target=new URL(record.params.redirectUri);target.searchParams.set('iss',issuer);if(record.params.state)target.searchParams.set('state',record.params.state);
  if(req.body.decision==='deny')target.searchParams.set('error','access_denied');
  else {const code=random();remember(codes,hash(code),{...record,expires:clock()+60000});target.searchParams.set('code',code);}
  res.redirect(302,target.href);
 });
 const challenge=`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${new URL(resource).pathname}", scope="${supportedScopes.join(' ')}"`;
 const middleware=async(req,res,next)=>{
  try {const match=/^Bearer (\S+)$/.exec(req.get('authorization')||'');if(!match)throw new InvalidTokenError('Missing token');req.auth=await provider.verifyAccessToken(match[1]);next();}
  catch {res.set('WWW-Authenticate',challenge).status(401).json({error:'OAuth authorization required'});}
 };
 middleware.verifyAccessToken=token=>provider.verifyAccessToken(token);
 // Single-use links remember the consent that minted them, never a token, and check it per chunk.
 middleware.grantOf=token=>{const entry=access.get(hash(token));return entry&&grants.has(entry.grantId)?entry.grantId:null;};
 middleware.grantScopes=id=>{const grant=grants.get(id);return grant&&grant.expires>clock()?grant.scopes:null;};
 middleware.resource=resource;
 return middleware;
}
