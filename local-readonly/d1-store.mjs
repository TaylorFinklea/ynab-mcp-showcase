import {random} from './core.mjs';
// D1 SQL adapter. Must be validated against deployed D1 before activation.
export class D1Store {
 constructor(db){this.db=db;}
 stmt(sql,...args){return this.db.prepare(sql).bind(...args);}
 async epoch(owner){await this.stmt('INSERT OR IGNORE INTO owner_epochs(owner,epoch) VALUES(?,0)',owner).run();return (await this.stmt('SELECT epoch FROM owner_epochs WHERE owner=?',owner).first()).epoch;}
 async putFlowForEpoch(owner,f,epoch){return (await this.stmt('INSERT INTO oauth_flows(owner,state_hash,payload,expires) SELECT owner,?,?,? FROM owner_epochs WHERE owner=? AND epoch=? ON CONFLICT(owner) DO UPDATE SET state_hash=excluded.state_hash,payload=excluded.payload,expires=excluded.expires',f.stateHash,f.payload,f.expires,owner,epoch).run()).meta.changes===1;}
 async connection(owner){return await this.stmt('SELECT * FROM connections WHERE owner=?',owner).first();}
 async flow(owner){const r=await this.stmt('SELECT * FROM oauth_flows WHERE owner=?',owner).first();return r?{stateHash:r.state_hash,payload:r.payload,expires:r.expires}:null;}
 async putFlow(owner,f){await this.stmt('INSERT INTO oauth_flows(owner,state_hash,payload,expires) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET state_hash=excluded.state_hash,payload=excluded.payload,expires=excluded.expires',owner,f.stateHash,f.payload,f.expires).run();}
 async claimFlow(owner,f,now){const id=random();const result=await this.db.batch([
 this.stmt("INSERT OR IGNORE INTO connections(owner,id,status) SELECT owner,?,'authorizing' FROM oauth_flows WHERE owner=? AND state_hash=? AND payload=? AND expires>?",id,owner,f.stateHash,f.payload,now),
 this.stmt('DELETE FROM oauth_flows WHERE owner=? AND state_hash=? AND payload=?',owner,f.stateHash,f.payload)
 ]);return result[0].meta.changes===1&&result[1].meta.changes===1?{id,status:'authorizing'}:null;}
 async failClaim(owner,c){await this.stmt("UPDATE connections SET status='reauthorization_required' WHERE owner=? AND id=? AND status='authorizing'",owner,c.id).run();}
 async completeClaim(owner,c,payload,status='authorized_unvalidated'){return (await this.stmt("UPDATE connections SET payload=?,status=? WHERE owner=? AND id=? AND status='authorizing'",payload,status,owner,c.id).run()).meta.changes===1;}
 async lockRefresh(owner,r,lease,proof){if(!Number.isSafeInteger(proof?.epoch))return null;const result=await this.stmt("UPDATE connections SET status='refreshing',prior_status=?,lease=? WHERE owner=? AND id=? AND status=? AND payload=? AND EXISTS(SELECT 1 FROM owner_epochs WHERE owner=? AND epoch=?)",r.status,lease,owner,r.id,r.status,r.payload,owner,proof.epoch).run();return result.meta.changes===1?{...r,status:'refreshing',prior_status:r.status,lease}:null;}

 async finishRefresh(owner,r,payload){return await this.stmt("UPDATE connections SET status=?,payload=?,lease=0,prior_status=NULL WHERE owner=? AND id=? AND status='refreshing' AND payload=? AND lease=? RETURNING *",r.prior_status,payload,owner,r.id,r.payload,r.lease).first();}

 async failRefresh(owner,r){await this.stmt("UPDATE connections SET status='reauthorization_required',lease=0 WHERE owner=? AND id=? AND status='refreshing' AND payload=? AND lease=?",owner,r.id,r.payload,r.lease).run();}
 async pin(owner,r,plan,proof){if(!Number.isSafeInteger(proof?.epoch))return false;return (await this.stmt("UPDATE connections SET plan_id=?,status='ready' WHERE owner=? AND id=? AND payload=? AND status IN ('authorized_unvalidated','ready') AND (plan_id IS NULL OR plan_id=?) AND EXISTS(SELECT 1 FROM owner_epochs WHERE owner=? AND epoch=?)",plan,owner,r.id,r.payload,plan,owner,proof.epoch).run()).meta.changes===1;}

 async disconnect(owner){await this.db.batch([this.stmt('INSERT INTO owner_epochs(owner,epoch) VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET epoch=epoch+1',owner),...['oauth_flows','connections'].map(table=>this.stmt('DELETE FROM '+table+' WHERE owner=?',owner))]);}
 async purgeExpired(now){await this.stmt('DELETE FROM oauth_flows WHERE expires<=?',now).run();}
}
