import {access,jsonBounded} from './core.mjs';
import {authority,unchanged,get} from './read.mjs';
import {categoryAllowed,transactionShape} from './review.mjs';
const ID=/^[a-zA-Z0-9-]{1,128}$/,ok=v=>typeof v==='string'&&ID.test(v),bad=()=>Error('invalid_items');
// The only code in the repo that builds a non-GET YNAB request: PATCH /plans/{plan}/transactions, each element exactly {id, category_id, approved: true}.
export function writeRequest(planId,updates,token){
 if(!ok(planId)||!Array.isArray(updates)||updates.length<1||updates.length>10||updates.some(u=>!ok(u?.id)||!ok(u?.category_id)))throw bad();
 return {url:'https://api.ynab.com/v1/plans/'+planId+'/transactions',init:{method:'PATCH',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token.access,'Content-Type':'application/json'},body:JSON.stringify({transactions:updates.map(u=>({id:u.id,category_id:u.category_id,approved:true}))})}};
}
const KEYS=['account_id','amount','approved','category_id','date'];
function validate(items){
 if(!Array.isArray(items)||items.length<1||items.length>10)throw bad();const seen=new Set();
 for(const i of items){const x=i?.expected;if(!i||!ok(i.transaction_id)||seen.has(i.transaction_id)||!ok(i.category_id)||!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).sort().join()!==KEYS.join()||!(x.category_id===null||typeof x.category_id==='string')||typeof x.approved!=='boolean'||!Number.isSafeInteger(x.amount)||typeof x.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(x.date)||typeof x.account_id!=='string')throw bad();seen.add(i.transaction_id);}
}
export async function categorize(owner,env,items,fetcher,now=Date.now(),proof){
 validate(items);proof=await authority(owner,env,proof,now);
 const ctx=await access(owner,env,fetcher,now,proof);if(!ok(ctx.row.plan_id))throw Error('plan_not_pinned');const planId=ctx.row.plan_id,base='/plans/'+planId;
 const step=async path=>{await authority(owner,env,proof,now);const raw=await get(path,ctx.token,fetcher);await unchanged(owner,env,ctx.row);await authority(owner,env,proof,now);return raw;};
 const groups=(await step(base+'/categories'))?.data?.category_groups;if(!Array.isArray(groups))throw Error('provider_read_failed');
 const allowed=new Set();for(const g of groups)for(const c of Array.isArray(g?.categories)?g.categories:[])if(typeof c?.id==='string'&&categoryAllowed(c,g))allowed.add(c.id);
 const results=items.map(i=>({transactionId:i.transaction_id})),send=[];
 for(const [n,i] of items.entries()){
  const skip=reason=>Object.assign(results[n],{outcome:'skipped',reason});
  if(!allowed.has(i.category_id)){skip('category_not_allowed');continue;}
  let t;try{t=(await step(base+'/transactions/'+i.transaction_id))?.data?.transaction;}catch(e){if(e.message==='not_found'){skip('not_found');continue;}throw e;}
  const shape=t?.id===i.transaction_id?transactionShape(t):'unsupported';if(shape!=='ok'){skip(shape);continue;}
  if(typeof t.approved!=='boolean'||!(t.category_id===null||typeof t.category_id==='string')){skip('unsupported');continue;}
  const x=i.expected;if(t.category_id!==x.category_id||t.approved!==x.approved||t.amount!==x.amount||t.date!==x.date||t.account_id!==x.account_id){skip('changed');continue;}
  send.push({n,id:i.transaction_id,category_id:i.category_id});
 }
 await authority(owner,env,proof,now);await unchanged(owner,env,ctx.row);
 if(send.length){
  const {url,init}=writeRequest(planId,send,ctx.token);let returned=null;
  try{const r=await fetcher(url,init);if(r.ok)returned=(await jsonBounded(r,1048576))?.data?.transactions;}catch{returned=null;}
  for(const s of send){const o=results[s.n],got=Array.isArray(returned)?returned.find(t=>t?.id===s.id):undefined;
   if(got&&got.category_id===s.category_id&&got.approved===true)o.outcome='updated';else{o.outcome='uncertain';if(got&&('category_id' in got||'approved' in got))o.returned={category_id:typeof got.category_id==='string'?got.category_id.slice(0,128):null,approved:typeof got.approved==='boolean'?got.approved:null};}}
 }
 return {planId,results};
}
