// Own DTO over CPA Manager's documented analytics API; never forwards raw events.
// Source: seakee/CPA-Manager-Plus internal/service/monitoring/service.go (MIT).
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
export function parseAnalytics(body: any, days: number) {
  if (!body?.summary || !Array.isArray(body.timeline) || !Array.isArray(body.model_stats)) throw new Error('Invalid analytics');
  const metrics = (v: any) => ({ requests: number(v.calls ?? v.total_calls), tokens: number(v.total_tokens),
    input: number(v.input_tokens), output: number(v.output_tokens), cache_read: number(v.cache_read_tokens),
    cache_write: number(v.cache_creation_tokens), reasoning: number(v.reasoning_tokens),
    // CPA costs are rate-table estimates, never invoices. Zero on active models may mean missing pricing.
    cost_usd: number(v.cost ?? v.total_cost) });
  const models = body.model_stats.slice(0,200).map((v:any) => ({ model: String(v.model ?? '').slice(0,120), ...metrics(v) }));
  const pricingUncertain = models.some((v:any) => v.tokens > 0 && (v.cost_usd === null || v.cost_usd === 0));
  return { days, as_of: number(body.generated_at_ms), source: 'CPA Manager persisted analytics', cost_kind: 'estimated',
    pricing_coverage: pricingUncertain ? 'incomplete' : 'unknown',
    coverage: body.coverage?.raw_complete === false ? 'partial' : 'source_retention_unknown',
    summary: {...metrics(body.summary), cost_usd: pricingUncertain ? null : number(body.summary.total_cost)},
    points: body.timeline.slice(0,800).filter((v:any)=>number(v.bucket_ms)!==null).map((v:any)=>({ at: v.bucket_ms, ...metrics(v), cost_usd: pricingUncertain ? null : number(v.cost) })),
    models: models.map((v:any)=>({...v,cost_usd:v.tokens>0 && v.cost_usd===0 ? null:v.cost_usd})) };
}
export class AnalyticsReader {
  private cache: {at:number; value:unknown} | null = null;
  private pending: Promise<unknown> | null = null;
  constructor(private url:string, private key:string, private fetcher:typeof fetch=fetch) {}
  async get():Promise<unknown> {
    if(this.cache && Date.now()-this.cache.at<60000) return this.cache.value;
    if(this.pending) return this.pending;
    this.pending=this.read().finally(()=>{this.pending=null});return this.pending;
  }
  private async read() {
    const now=Date.now();
    const ranges=[];
    for(const days of [1,7,30]) {
      const r=await this.fetcher(this.url.replace(/\/$/,'')+'/v0/management/monitoring/analytics',{
        method:'POST',headers:{Authorization:'Bearer '+this.key,'Content-Type':'application/json'},
        body:JSON.stringify({from_ms:now-days*86400000,to_ms:now,time_zone:'UTC',include:{summary:true,timeline:true,model_stats:true,granularity:days===1?'hour':'day'}}),signal:AbortSignal.timeout(15000)});
      if(!r.ok) throw new Error('Analytics unavailable');
      ranges.push(parseAnalytics(await r.json(),days));
    }
    const value={ranges};this.cache={at:Date.now(),value};return value;
  }
}
