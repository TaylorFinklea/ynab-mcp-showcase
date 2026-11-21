import {test} from 'node:test';import assert from 'node:assert/strict';import worker from './worker.mjs';
const req=(p,options)=>new Request('https://fictional.invalid'+p,options);
test('health explicitly disabled',async()=>{const r=await worker.fetch(req('/health'));assert.equal(r.status,200);assert.equal((await r.json()).realYNABConnected,false);});
test('no writes, no callbacks and no input echo',async()=>{for(const method of ['POST','PATCH','PUT','DELETE'])assert.equal((await worker.fetch(req('/v1/transactions',{method}))).status,405);const r=await worker.fetch(req('/oauth/callback?code=FICTIONAL_SENTINEL'));assert.equal(r.status,503);assert.ok(!(await r.text()).includes('FICTIONAL_SENTINEL'));});
test('forged identity cannot enable data',async()=>{assert.equal((await worker.fetch(req('/v1/plan/month',{headers:{'oai-authenticated-user-id':'owner'}}))).status,503);});
