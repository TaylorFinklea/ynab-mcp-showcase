// Test adapter only. No durable persistence; never use in deployed authorization.
export class MockStore {
 flows=new Map();connections=new Map();epochs=new Map();generation=0;
 async epoch(o){return this.epochs.get(o)??0;}
 async putFlowForEpoch(o,f,epoch){if(epoch!==await this.epoch(o))return false;this.flows.set(o,f);return true;}
 async connection(o){return this.connections.get(o);}
 async flow(o){return this.flows.get(o);}
 async putFlow(o,f){this.flows.set(o,f);}
 async claimFlow(o,f,now){if(this.beforeClaim)this.beforeClaim();if(this.flows.get(o)!==f||f.expires<=now||this.connections.has(o))return null;const claim={id:++this.generation,status:'authorizing'};this.flows.delete(o);this.connections.set(o,claim);return claim;}
 async failClaim(o,c){if(this.connections.get(o)===c)this.connections.set(o,{id:c.id,status:'reauthorization_required'});}
 async completeClaim(o,c,payload,status='ready'){if(this.connections.get(o)!==c)return false;this.connections.set(o,{id:c.id,status,payload});return true;}
 async lockRefresh(o,r,lease){if(this.connections.get(o)!==r)return null;const locked={...r,status:'refreshing',lease};this.connections.set(o,locked);return locked;}
 async finishRefresh(o,r,payload){if(this.connections.get(o)!==r)return false;const next={id:r.id,status:'ready',payload};this.connections.set(o,next);return next;}
 async failRefresh(o,r){if(this.connections.get(o)===r)this.connections.set(o,{...r,status:'reauthorization_required'});}
 async disconnect(o){this.epochs.set(o,(this.epochs.get(o)??0)+1);this.flows.delete(o);this.connections.delete(o);}
}
