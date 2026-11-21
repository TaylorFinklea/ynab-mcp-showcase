// Pure official-schema projection; financial interpretation never writes data.
// Target semantics verified 2026-11-15 via YNAB OpenAPI1.91.0 + official target/rollover guides.
const goals=['goal_type','goal_target','goal_target_date','goal_target_day','goal_cadence','goal_cadence_frequency','goal_creation_month','goal_months_to_budget','goal_overall_funded','goal_overall_left','goal_under_funded','goal_percentage_complete','goal_snoozed_at','goal_needs_whole_amount'];
export function projectMonth({month,previousMonth,categories,priorCategories,groups,limits={},roles={}}){
 if(!Array.isArray(categories)||!Array.isArray(priorCategories)||!Array.isArray(groups))throw Error('incomplete_input');
 const prior=new Map(priorCategories.map(c=>[c.id,c])),group=new Map(groups.map(g=>[g.id,g.name]));
 return categories.map(c=>{
  if(!c||typeof c.id!=='string'||typeof c.name!=='string'||[c.budgeted,c.activity,c.balance].some(x=>!Number.isSafeInteger(x)))throw Error('invalid_amount');
  const p=prior.get(c.id),limit=limits[c.id];if(limit!==undefined&&(!Number.isSafeInteger(limit)||limit<=0))throw Error('invalid_limit');
  const netSpent=-c.activity,carry=c.balance-c.budgeted-c.activity;
  const priorAvailable=p&&Number.isSafeInteger(p.balance)?p.balance:null;
  const expectedCarry=priorAvailable===null?null:Math.max(priorAvailable,0);
  const target=Object.fromEntries(goals.map(k=>[k,c[k]??null]));
  for(const [k,v]of Object.entries(target)){if(v===null)continue;if(k==='goal_type'){if(!['TB','TBD','MF','NEED','DEBT'].includes(v))throw Error('unknown_target_type');}else if(k==='goal_needs_whole_amount'){if(typeof v!=='boolean')throw Error('invalid_target');}else if(['goal_target_date','goal_creation_month','goal_snoozed_at'].includes(k)){if(typeof v!=='string'||v.length>40)throw Error('invalid_target');}else if(!Number.isSafeInteger(v)||v<0)throw Error('invalid_target');}

  const monthlyTarget=c.goal_type==='NEED'&&c.goal_cadence===1&&(c.goal_cadence_frequency===1||c.goal_cadence_frequency==null)&&Number.isSafeInteger(c.goal_target)?c.goal_target:null;
  const ratio=limit===undefined?null:netSpent/limit;
  return {month,previousMonth,groupId:c.category_group_id,group:group.get(c.category_group_id)??null,id:c.id,name:c.name,hidden:c.hidden===true,internal:c.internal===true,
   role:roles[c.id]??'unclassified',statusBasis:'limit utilization only: approaching at 80%; not calendar pacing',units:'milliunits',assigned:c.budgeted,netSpent,spendingBasis:'negative net activity; not gross purchases',available:c.balance,
   target,monthlyTarget,spendingLimit:limit??null,limitRemaining:limit===undefined?null:limit-netSpent,spendingPercent:ratio===null?null:ratio*100,
   status:c.balance<0?'over budget':ratio===null?'unknown':ratio>1?'over budget':ratio>=0.8?'approaching limit':'on track',
   impliedStartingCarry:carry,priorAvailable,expectedPositiveCarry:expectedCarry,carryMatches:expectedCarry===null?null:carry===expectedCarry,
   ambiguity:[...(limit===undefined?['No verified spending limit; assigned and target are not automatically limits.']:[]),...(group.has(c.category_group_id)?[]:['Category group missing.']),...(expectedCarry===null?['Prior category balance unavailable.']:carry!==expectedCarry?['Implied carry differs from positive prior balance; investigate adjustments.']:[]),...(priorAvailable!==null&&priorAvailable<0?['Negative prior balance does not simply carry: cash overspending affects Ready to Assign; credit overspending becomes debt.']:[]),...(roles[c.id]==='debt'?['Debt/card-payment activity is not ordinary purchase spending; avoid double count.']:[])]};
 });
}
