import {access} from './core.mjs';
import {authority,unchanged,get} from './read.mjs';
const id={test:v=>typeof v==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(v)};
const str=(x,n)=>typeof x==='string'?x.slice(0,n):null;
// The category's own internal flag decides: YNAB also marks ordinary groups such as Bills and Expenses internal.
// Inside an internal group, a category without an explicit internal flag is refused (fail closed).
export const categoryAllowed=(c,g)=>!(c?.deleted===true||c?.hidden===true||g?.deleted===true||g?.hidden===true||g?.name==='Credit Card Payments'||(g?.internal===true&&typeof c?.internal!=='boolean')||(c?.internal===true&&c?.name!=='Inflow: Ready to Assign'));
export function transactionShape(t){if(t?.deleted===true)return 'deleted';if(Array.isArray(t?.subtransactions)&&t.subtransactions.length>0||t?.category_name==='Split')return 'split';if(typeof t?.transfer_account_id==='string')return 'transfer';if(typeof t?.id!=='string'||typeof t?.date!=='string'||typeof t?.account_id!=='string'||!Number.isSafeInteger(t?.amount))return 'unsupported';return 'ok';}
async function read(owner,env,fetcher,now,proof,maxBytes){proof=await authority(owner,env,proof,now);return {proof,run:async(build)=>{const ctx=await access(owner,env,fetcher,now,proof);if(!id.test(ctx.row.plan_id||''))throw Error('plan_not_pinned');await authority(owner,env,proof,now);const raw=await get(build(ctx.row.plan_id),ctx.token,fetcher,maxBytes);await unchanged(owner,env,ctx.row);await authority(owner,env,proof,now);return {raw,planId:ctx.row.plan_id};}};}
export async function listCategories(owner,env,fetcher,now=Date.now(),proof){
 const {run}=await read(owner,env,fetcher,now,proof),{raw,planId}=await run(p=>'/plans/'+p+'/categories'),groups=raw?.data?.category_groups;
 if(!Array.isArray(groups)||groups.length>1000)throw Error('provider_response');let n=0;
 return {planId,groups:groups.map(g=>{if(!g||typeof g.id!=='string'||typeof g.name!=='string'||!Array.isArray(g.categories))throw Error('provider_response');n+=g.categories.length;if(n>5000)throw Error('provider_response');
  return {id:g.id,name:g.name.slice(0,256),hidden:g.hidden===true,deleted:g.deleted===true,internal:g.internal===true,categories:g.categories.map(c=>{if(!c||typeof c.id!=='string'||typeof c.name!=='string')throw Error('provider_response');return {id:c.id,name:c.name.slice(0,256),hidden:c.hidden===true,deleted:c.deleted===true,internal:c.internal===true,categorizable:categoryAllowed(c,g)};})};})};
}
export async function listReview(owner,env,{type,sinceDate,limit=50}={},fetcher,now=Date.now(),proof){
 const ctx=await read(owner,env,fetcher,now,proof,2097152);
 if(type!=='uncategorized'&&type!=='unapproved')throw Error('invalid_type');
 if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('invalid_limit');
 const day=ms=>new Date(ms).toISOString().slice(0,10),today=day(now);sinceDate??=day(now-14*86400000);
 if(typeof sinceDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate)||isNaN(Date.parse(sinceDate))||day(Date.parse(sinceDate))!==sinceDate||sinceDate>today)throw Error('invalid_since_date');
 let out;try{out=await ctx.run(p=>'/plans/'+p+'/transactions?type='+type+'&since_date='+sinceDate);}catch(e){throw Error(e.message==='too_large'?'narrow_dates':e.message);}
 const list=out.raw?.data?.transactions;if(!Array.isArray(list))throw Error('provider_response');
 const rows=list.filter(t=>transactionShape(t)!=='deleted'&&transactionShape(t)!=='unsupported').sort((a,b)=>a.date<b.date?1:a.date>b.date?-1:a.id<b.id?-1:a.id>b.id?1:0);
 return {planId:out.planId,type,sinceDate,moreAvailable:rows.length>limit,transactions:rows.slice(0,limit).map(t=>({id:t.id,date:t.date,amount:t.amount,amountFormatted:typeof t.amount_formatted==='string'&&t.amount_formatted.length<=64?t.amount_formatted:null,payeeName:str(t.payee_name,256),memo:str(t.memo,512),accountId:t.account_id,accountName:str(t.account_name,256),categoryId:str(t.category_id,128),categoryName:str(t.category_name,256),approved:t.approved===true,cleared:str(t.cleared,32),isSplit:transactionShape(t)==='split',isTransfer:transactionShape(t)==='transfer'}))};
}
