// Undeployed OAuth core (full YNAB access, epoch-only authority). Storage/authenticated read adapters require separate review.
const te=new TextEncoder(),td=new TextDecoder();
export const b64=b=>btoa(String.fromCharCode(...b)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
const bytes=s=>Uint8Array.from(atob(s.replaceAll('-','+').replaceAll('_','/')),x=>x.charCodeAt(0));
export const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
export const hash=async s=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',te.encode(s))));
export const safeties={'Cache-Control':'no-store','Referrer-Policy':'no-referrer','NEL':'{"max_age":0}','Report-To':'{"group":"cf-nel","max_age":0,"endpoints":[]}','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'X-Robots-Tag':'noindex, nofollow'};
const originOk=o=>{try{const u=new URL(o);return typeof o==='string'&&u.protocol==='https:'&&u.origin===o;}catch{return false;}};
export function enabled(e){if(e?.enabled!==true||!e.clientId||!e.clientSecret||!e.vaultKey||!e.owner||!e.store||!originOk(e.origin))throw Error('disabled');}
export const callbackURL=e=>e.origin+'/oauth/callback';
export async function seal(value,key,aad){const iv=crypto.getRandomValues(new Uint8Array(12));return b64(iv)+'.'+b64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:te.encode(aad)},key,te.encode(JSON.stringify(value)))));}
export async function open(value,key,aad){const [iv,cipher,...rest]=value.split('.');if(rest.length||!iv||!cipher)throw Error('envelope');return JSON.parse(td.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(iv),additionalData:te.encode(aad)},key,bytes(cipher))));}
export function authorizationURL(clientId,redirectUri,state,challenge){return 'https://app.ynab.com/oauth/authorize?'+new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',state,code_challenge:challenge,code_challenge_method:'S256'});}
const clearCookie='__Host-ynab-flow=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';
export const clean=e=>new Response(null,{status:303,headers:{...safeties,Location:e.origin+'/setup','Set-Cookie':clearCookie}});
export async function begin(owner,env,now=Date.now(),proof=null){
 enabled(env);if(owner!==env.owner||await env.store.connection(owner))throw Error('unauthorized');
 // Production callers require an epoch proof; mock-only opt-in exists for local tests.
 const state=random(),nonce=random(),verifier=random(),stateHash=await hash(state);
 const flow={stateHash,expires:now+600000,payload:await seal({verifier,nonceHash:await hash(nonce)},env.vaultKey,'flow:'+owner+':'+stateHash)};
 if(proof){if(!Number.isSafeInteger(proof.epoch)||!await env.store.putFlowForEpoch(owner,flow,proof.epoch))throw Error('authorization_changed');}else if(env.mockOnly===true){await env.store.putFlow(owner,flow);}else throw Error('authority_required');
 return {location:authorizationURL(env.clientId,callbackURL(env),state,await hash(verifier)),cookie:'__Host-ynab-flow='+nonce+'; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600'};
}
async function readBounded(body,max){if(!body)return new Uint8Array();const r=body.getReader();let n=0,parts=[];try{for(;;){const x=await r.read();if(x.done)break;n+=x.value.length;if(n>max)throw Error('too_large');parts.push(x.value);}const all=new Uint8Array(n);let at=0;for(const p of parts){all.set(p,at);at+=p.length;}return all;}finally{await r.cancel().catch(()=>{});}}
export async function jsonBounded(response,maxBytes=16384){return JSON.parse(td.decode(await readBounded(response.body,maxBytes)));}

function tokens(t,now){if(t?.token_type?.toLowerCase()!=='bearer'||typeof t.access_token!=='string'||!t.access_token||t.access_token.length>4096||typeof t.refresh_token!=='string'||!t.refresh_token||t.refresh_token.length>4096||!Number.isSafeInteger(t.expires_in)||t.expires_in<1||t.expires_in>86400)throw Error('token_response');return {access:t.access_token,refresh:t.refresh_token,expires:now+t.expires_in*1000};}
const exchange=(body,fetcher)=>fetcher('https://app.ynab.com/oauth/token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
export async function callback(request,env,fetcher=fetch,now=Date.now()){
 let validated=false,claimed=null;
 try{enabled(env);const u=new URL(request.url);if(request.method!=='GET'||u.origin!==env.origin||u.pathname!=='/oauth/callback')throw Error('request');
 const state=u.searchParams.get('state'),code=u.searchParams.get('code');if(u.searchParams.getAll('state').length!==1||!/^[A-Za-z0-9_-]{43}$/.test(state||'')||(!u.searchParams.has('error')&&(u.searchParams.getAll('code').length!==1||!code||code.length>2048)))throw Error('request');
 const cookies=(request.headers.get('cookie')||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-ynab-flow='));if(cookies.length!==1)throw Error('cookie');const nonce=cookies[0].split('=')[1];if(!/^[A-Za-z0-9_-]{43}$/.test(nonce||''))throw Error('cookie');
 const stateHash=await hash(state),flow=await env.store.flow(env.owner);if(!flow||flow.stateHash!==stateHash||flow.expires<=now)throw Error('flow');const pending=await open(flow.payload,env.vaultKey,'flow:'+env.owner+':'+stateHash);if(pending.nonceHash!==await hash(nonce))throw Error('cookie');validated=true;
 const claim=await env.store.claimFlow(env.owner,flow,now);claimed=claim;if(!claim)throw Error('consumed');
 if(u.searchParams.has('error')){await env.store.failClaim(env.owner,claim);return clean(env);}
 const res=await exchange(new URLSearchParams({client_id:env.clientId,client_secret:env.clientSecret,redirect_uri:callbackURL(env),grant_type:'authorization_code',code,code_verifier:pending.verifier}),fetcher);if(!res.ok)throw Error('provider');
 const token=tokens(await jsonBounded(res),now),payload=await seal(token,env.vaultKey,'tokens:'+env.owner);
 await env.store.completeClaim(env.owner,claim,payload,'authorized_unvalidated');return clean(env);
 }catch{if(claimed){try{await env.store.failClaim(env.owner,claimed);}catch{/* Persisted outcome unknown; never log storage details. */}}return validated?clean(env):new Response('Connection unavailable.',{status:400,headers:safeties});}
}
export async function access(owner,env,fetcher=fetch,now=Date.now(),proof){
 enabled(env);if(owner!==env.owner)throw Error('unauthorized');const row=await env.store.connection(owner);if(row?.status==='refreshing'&&row.lease>now)throw Error('refresh_in_progress');if(!row||row.status!=='ready')throw Error('reauthorization_required');
 const token=await open(row.payload,env.vaultKey,'tokens:'+owner);if(token.expires>now+60000)return {token,row};
 if(!proof&&env.mockOnly!==true)throw Error('authority_required');const locked=await env.store.lockRefresh(owner,row,now+30000,proof,now);if(!locked)throw Error('refresh_in_progress');
 try{const response=await exchange(new URLSearchParams({client_id:env.clientId,client_secret:env.clientSecret,grant_type:'refresh_token',refresh_token:token.refresh}),fetcher);if(!response.ok)throw Error('provider');const next=tokens(await jsonBounded(response),now);const payload=await seal(next,env.vaultKey,'tokens:'+owner);
 const saved=await env.store.finishRefresh(owner,locked,payload);if(!saved)throw Error('connection_changed');return {token:next,row:saved};
 }catch{try{await env.store.failRefresh(owner,locked);}catch{/* Keep generic failure even if storage is unavailable. */}throw Error('reauthorization_required');}
}
export async function disconnect(owner,env){enabled(env);if(owner!==env.owner)throw Error('unauthorized');await env.store.disconnect(owner);return {localDisconnected:!await env.store.connection(owner),providerRevocationVerified:false};}
export function categoryProjection(data){if(!Array.isArray(data)||data.length>1000)throw Error('response');return data.map(c=>{if(!c||typeof c.id!=='string'||c.id.length>128||typeof c.name!=='string'||c.name.length>256||typeof c.category_group_id!=='string'||c.category_group_id.length>128||[c.budgeted,c.activity,c.balance].some(x=>!Number.isSafeInteger(x)))throw Error('response');const f=x=>typeof x==='string'&&x.length<=64?x:null;return {id:c.id,name:c.name,groupId:c.category_group_id,assigned:c.budgeted,activity:c.activity,available:c.balance,assignedFormatted:f(c.budgeted_formatted),activityFormatted:f(c.activity_formatted),availableFormatted:f(c.balance_formatted)};});}
