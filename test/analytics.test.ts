import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAnalytics} from '../src/analytics.js';
test('does not turn missing pricing into free usage or expose raw data',()=>{
 const r=parseAnalytics({summary:{total_calls:1,total_tokens:90,total_cost:0},timeline:[{bucket_ms:100,calls:1,total_tokens:90,cost:0}],model_stats:[{model:'unknown',total_tokens:90,cost:0,api_key:'secret'}]},1);
 assert.equal(r.summary.cost_usd,null);assert.equal(r.points[0].cost_usd,null);assert.equal(r.pricing_coverage,'incomplete');assert.ok(!JSON.stringify(r).includes('secret'));
});
test('zero requests and absent token values remain distinct',()=>{
 const r=parseAnalytics({summary:{total_calls:0,total_cost:0},timeline:[],model_stats:[]},1);
 assert.equal(r.summary.requests,0);assert.equal(r.summary.tokens,null);assert.equal(r.summary.cost_usd,0);
 assert.throws(()=>parseAnalytics({},1));
});
test('mixed priced and unpriced models keep the known subtotal with incomplete coverage',()=>{
 const r=parseAnalytics({summary:{total_calls:2,total_tokens:180,total_cost:1},timeline:[{bucket_ms:100,total_tokens:180,cost:1}],model_stats:[{model:'priced',total_tokens:90,cost:1},{model:'unknown',total_tokens:90,cost:0}]},7);
 assert.equal(r.summary.cost_usd,1);assert.equal(r.points[0].cost_usd,1);assert.equal(r.models[1].cost_usd,null);assert.equal(r.pricing_coverage,'incomplete');
});
