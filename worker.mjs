// Disabled fictional-only infrastructure probe. No OAuth, token, provider, or write implementation.
const headers={'NEL':'{"max_age":0}', 'Report-To':'{"group":"cf-nel","max_age":0,"endpoints":[]}', 'X-Robots-Tag':'noindex, nofollow', 'Content-Type':'application/json','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'"};
export default {async fetch(request){
 const url=new URL(request.url);
 if(request.method!=='GET')return new Response(JSON.stringify({error:'disabled'}),{status:405,headers});
 if(url.pathname==='/health'&&!url.search)return new Response(JSON.stringify({mode:'disabled_fictional_infrastructure',realYNABConnected:false,realReadsEnabled:false,realWritesEnabled:false,authenticationConfigured:false}),{status:200,headers});
 // Never consume or reflect callbacks/headers/query. No provider exchange, DB access or app logging.
 return new Response(JSON.stringify({error:'not_configured'}),{status:503,headers});
}};
