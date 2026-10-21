const repo=require('../repositories/business.repository');
const access=require('./businessAccess.service');
const v=require('../../../../utils/validate');
const {decimal,dateText,uuid}=require('./business.service');
const AppError=require('../../../../utils/AppError');
const paise=(amount)=>Math.round(Number(amount)*100);
const money=(amount)=>(amount/100).toFixed(2);
const fail=(message,status=400)=>{throw new AppError(status,message);};

async function selectedLocation(business,value) {
  const id=v.requiredId(value||business.location_scope||business.member_location_id,'Choose one location');
  access.requireLocation(business,id);
  if(!business.active_location_ids.map(String).includes(String(id))) fail('Location not available',404);
  return id;
}
async function list(business,query) {
  await access.requireAny(business,['sales.view','reports.view']);
  if(business.modules.includes('expenses')) await access.require(business,'expenses.view');
  const date=dateText(query.date,'Cash check date');
  const location=await selectedLocation(business,query.locationId||query.location);
  return repo.all(repo.pool,`SELECT c.*,c.checked_on::text AS checked_on,u.name AS created_by_name FROM business_cash_checks c JOIN users u ON u.id=c.created_by
    WHERE c.business_id=$1 AND c.location_id=$2 AND c.checked_on=$3 ORDER BY c.id DESC LIMIT 20`,[business.id,location,date]);
}
async function create(business,user,body) {
  await access.require(business,'reports.edit');
  await access.requireAny(business,['sales.view','reports.view']);
  const date=dateText(body.date,'Cash check date');
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:business.timezone}).format(new Date());
  if(date>today) fail('A cash check cannot have a future date');
  const location=await selectedLocation(business,body.locationId);
  const opening=decimal(body.openingCash,'Opening cash',2,0,999999999).toFixed(2);
  const counted=decimal(body.countedCash,'Counted cash',2,0,999999999).toFixed(2);
  const reason=v.optionalString(body.reason,'Reason',300);
  const key=uuid(body.requestKey);
  const replay=(row)=>{
    if(String(row.location_id)!==String(location)||String(row.created_by)!==String(user.id)
      ||Number(row.opening_cash)!==Number(opening)||Number(row.counted_cash)!==Number(counted)
      ||row.checked_on!==date||(row.reason||null)!==(reason||null)) {
      fail('This request already recorded a different cash check',409);
    }
    return row;
  };
  // A reader without expense access cannot reconcile a drawer containing hidden outgoings.
  if(business.modules.includes('expenses')) await access.require(business,'expenses.view');
  return repo.transaction(async(db)=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const old=await repo.one(db,'SELECT *,checked_on::text AS checked_on FROM business_cash_checks WHERE business_id=$1 AND request_key=$2',[business.id,key]);
    if(old) return replay(old);
    const data=await require('./businessTakings.service').takings(business,{from:date,to:date,locationId:location},db);
    const movement=paise(data.cashInHand);
    const expected=paise(opening)+movement;
    const difference=paise(counted)-expected;
    if(difference!==0&&!reason) fail('Give a reason for the cash difference');
    const row=await repo.one(db,`INSERT INTO business_cash_checks(business_id,location_id,checked_on,opening_cash,counted_cash,movement_cash,expected_cash,difference,reason,request_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(business_id,request_key) DO NOTHING RETURNING *,checked_on::text AS checked_on`,
      [business.id,location,date,opening,counted,money(movement),money(expected),money(difference),reason,key,user.id]);
    if(!row) fail('This cash check is already being saved; reload before trying again',409);
    await repo.audit(db,business.id,user.id,'cash.checked',row.id,{date,locationId:location,openingCash:opening,countedCash:counted,expectedCash:money(expected),difference:money(difference),reason});
    return row;
  }).catch(async(error)=>{
    // Two concurrent retries may collide with the repeatable-read snapshot.
    // Return the committed original receipt, after checking the same input.
    if(!['40001','23505'].includes(error.code)) throw error;
    const row=await repo.one(repo.pool,'SELECT *,checked_on::text AS checked_on FROM business_cash_checks WHERE business_id=$1 AND request_key=$2',[business.id,key]);
    if(!row) throw error;
    return replay(row);
  });
}
module.exports={list,create};
