const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const {Client}=require('pg');

test('business expenses and cash checks preserve money, scope, retries and audit history', {timeout:300000}, async(t)=>{
  require('dotenv').config({quiet:true});
  const database=`rmp_test_${crypto.randomBytes(10).toString('hex')}`;
  const connection={host:process.env.DB_HOST,port:Number(process.env.DB_PORT),user:process.env.DB_USER,password:process.env.DB_PASSWORD};
  const admin=new Client({...connection,database:'postgres',connectionTimeoutMillis:10000});
  let pool,created=false;
  await admin.connect();
  t.after(async()=>{
    if(pool)await pool.end();
    try{if(created&&/^rmp_test_[a-f0-9]{20}$/.test(database))await admin.query(`DROP DATABASE "${database}"`);}
    finally{await admin.end();}
  });
  await admin.query(`CREATE DATABASE "${database}"`);created=true;
  process.env.DB_NAME=database;process.env.NODE_ENV='test';process.env.MULTI_BUSINESS_DEVELOPMENT='true';
  const {runner}=await import('node-pg-migrate');
  await runner({databaseUrl:{...connection,database},dir:path.resolve(__dirname,'../../migrations'),migrationsTable:'pgmigrations',direction:'up',count:Infinity,checkOrder:true,log(){}});
  pool=require('../../src/config/database');
  const one=async(sql,args=[])=>(await pool.query(sql,args)).rows[0];
  const restaurant=await one("INSERT INTO restaurants(name,code) VALUES('Expense test','EXPTEST') RETURNING id");
  const user=await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,'Owner','expense-owner@test.invalid','unused-test-password') RETURNING id",[restaurant.id]);
  async function makeBusiness(code){
    const business=await one("INSERT INTO businesses(name,code,business_type,created_by) VALUES($1,$1,'grocery',$2) RETURNING id",[code,user.id]);
    await pool.query('INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by) SELECT $1,$2,id,$2,$2 FROM business_roles WHERE business_id=$1 AND full_access',[business.id,user.id]);
    const location=await one("INSERT INTO business_locations(business_id,name,code) VALUES($1,'Shop','SHOP') RETURNING id",[business.id]);
    return {business,location};
  }
  const first=await makeBusiness('EXP-A'),second=await makeBusiness('EXP-B');
  const access=require('../../src/modules/business/core/services/businessAccess.service');
  const expenses=require('../../src/modules/business/core/services/businessExpenses.service');
  const cash=require('../../src/modules/business/core/services/businessCashChecks.service');
  const takings=require('../../src/modules/business/core/services/businessTakings.service');
  const service=require('../../src/modules/business/core/services/business.service');
  const setup=require('../../src/modules/business/core/services/businessSetup.service');
  const business=await access.load(user,first.business.id);
  const other=await access.load(user,second.business.id);
  const day=(await one("SELECT (now() AT TIME ZONE $1)::date::text AS today,((now() AT TIME ZONE $1)::date-1)::text AS yesterday",[business.timezone]));
  const base={spentOn:day.today,category:'utilities',description:'Electricity',amount:'120.01',method:'cash',locationId:first.location.id,requestKey:crypto.randomUUID()};
  const [a,b]=await Promise.all([expenses.create(business,user,base),expenses.create(business,user,base)]);
  assert.equal(a.id,b.id,'A repeated submission records one expense');
  assert.equal((await one('SELECT count(*)::int AS n FROM business_expenses')).n,1);
  await assert.rejects(setup.setModule(business,user,'expenses',{enabled:false}),/must stay enabled/);
  await assert.rejects(expenses.create(business,user,{...base,amount:'130.01'}),/different expense/);
  await assert.rejects(expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),spentOn:'2999-01-01'}),/future/);
  await assert.rejects(expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),method:'cheque'}));
  await assert.rejects(expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),locationId:second.location.id}),/not available/);
  const limited={...business,full_access:false,permissions:['expenses.view','reports.view'],modules:business.modules};
  await assert.rejects(expenses.create(limited,user,{...base,requestKey:crypto.randomUUID()}),/does not allow/);
  const hiddenExpenses={...limited,permissions:['reports.view','reports.edit']};
  await assert.rejects(cash.list(hiddenExpenses,{date:day.today,locationId:first.location.id}),/does not allow/);
  await expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),amount:'49.99',method:'upi'});
  const old=await expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),spentOn:day.yesterday,amount:'30.00',description:'Cleaning'});
  const range={from:day.today,to:day.today,locationId:first.location.id};
  const ledger=await takings.takings(business,range);
  assert.equal(ledger.expenses.total,'170.00');assert.equal(ledger.expenses.cash,'120.01');assert.equal(ledger.cashInHand,'-120.01');assert.equal(ledger.net,'-170.00');
  const report=await service.reports(business,{...range,location:first.location.id});
  assert.equal(report.rows.find(r=>r.kind==='expense').total,'170.00');
  const checkBody={date:day.today,locationId:first.location.id,openingCash:'1000.00',countedCash:'879.99',requestKey:crypto.randomUUID()};
  await assert.rejects(cash.create(hiddenExpenses,user,checkBody),/does not allow/);
  const [check,repeatedCheck]=await Promise.all([cash.create(business,user,checkBody),cash.create(business,user,checkBody)]);
  assert.equal(check.id,repeatedCheck.id,'Concurrent cash-check retries save one snapshot');
  assert.equal(check.expected_cash,'879.99');assert.equal(check.difference,'0.00');
  assert.equal((await cash.create(business,user,checkBody)).id,check.id);
  await assert.rejects(cash.create(business,user,{...checkBody,requestKey:crypto.randomUUID(),countedCash:'800.00'}),/reason/);
  const short=await cash.create(business,user,{...checkBody,requestKey:crypto.randomUUID(),countedCash:'800.00',reason:'Cash short at count'});
  assert.equal(short.difference,'-79.99');
  await assert.rejects(pool.query(`INSERT INTO business_cash_checks(business_id,location_id,checked_on,opening_cash,counted_cash,movement_cash,expected_cash,difference,request_key,created_by)
    VALUES($1,$2,$3,0,1,0,0,1,$4,$5)`,[business.id,first.location.id,day.today,crypto.randomUUID(),user.id]),/business_cash_checks_reason/);
  await assert.rejects(pool.query('UPDATE business_expenses SET voided_at=now(),voided_by=$2,void_reason=NULL WHERE id=$1',[a.id,user.id]),/business_expenses_void_shape/);
  await assert.rejects(expenses.reverse(other,user,a.id,{reason:'Wrong tenant'}),/not found/);
  await assert.rejects(expenses.reverse(business,user,a.id,{reason:''}));
  await expenses.reverse(business,user,old.id,{reason:'Incorrect duplicate entry'});
  const after=await takings.takings(business,range);
  assert.equal(after.expenses.total,'140.00');assert.equal(after.cashInHand,'-90.01');
  const originalDay=await takings.takings(business,{from:day.yesterday,to:day.yesterday,locationId:first.location.id});
  assert.equal(originalDay.expenses.cash,'30.00','Reversal is on its own day, not retroactive');
  // A role that may not see expenses still gets the true drawer figure, without the breakdown.
  const salesOnly=await takings.takings({...business,full_access:false,permissions:['sales.view'],modules:business.modules},range);
  assert.equal(salesOnly.cashInHand,after.cashInHand);assert.equal(salesOnly.net,after.net);
  assert.deepEqual(salesOnly.expenses,{visible:false});assert.deepEqual(salesOnly.byMethodName.expenses,[]);
  // Counted days stay as counted, and old days are settled.
  await assert.rejects(expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),spentOn:day.yesterday}),/already counted/);
  const longAgo=(await one("SELECT ((now() AT TIME ZONE $1)::date-31)::text AS d",[business.timezone])).d;
  await assert.rejects(expenses.create(business,user,{...base,requestKey:crypto.randomUUID(),spentOn:longAgo}),/30 days back/);
  const totals=(await expenses.list(business,range)).totals;
  assert.equal(Number(totals.paid),170);assert.equal(Number(totals.reversed),30);
  const audit=await one("SELECT count(*)::int AS n FROM business_audit WHERE business_id=$1 AND action IN ('expense.recorded','expense.reversed','cash.checked')",[business.id]);
  assert.equal(audit.n,6);
  await assert.rejects(pool.query('UPDATE business_expenses SET amount=1 WHERE id=$1',[a.id]),/only be reversed/);
  await assert.rejects(pool.query('DELETE FROM business_cash_checks WHERE id=$1',[check.id]),/permanent snapshots/);
  const secondBranch=await one("INSERT INTO business_locations(business_id,name,code) VALUES($1,'Other branch','OTHER') RETURNING id",[business.id]);
  const tied={...business,member_location_id:secondBranch.id,member_location_name:'Other branch',location_scope:secondBranch.id,active_location_ids:[secondBranch.id]};
  await assert.rejects(expenses.reverse(tied,user,a.id,{reason:'Wrong branch'}),/only/);
  await assert.rejects(cash.list(tied,{date:day.today,locationId:first.location.id}),/only/);
  const defaults=await pool.query("SELECT module_code,enabled_by_default FROM platform_module_business_types WHERE business_type='healthcare' AND module_code IN ('tasks','issues','projects','lab')");
  assert.ok(defaults.rows.every(r=>!r.enabled_by_default),'Advanced workflows start off');
  // A recommendation points an owner to a tool that starts off; it switches nothing on.
  const recommended=(await pool.query("SELECT business_type,module_code,enabled_by_default,recommended_note FROM platform_module_business_types WHERE recommended")).rows;
  assert.ok(recommended.length>=20 && recommended.every(r=>!r.enabled_by_default && r.recommended_note));
  assert.ok(recommended.some(r=>r.business_type==='healthcare'&&r.module_code==='lab'));
  const groceryTools=await setup.modules(business);
  assert.ok(groceryTools.every(m=>m.recommended===false && m.recommended_note===null),'A kirana is pointed to nothing extra');
  await setup.setModule(other,user,'expenses',{enabled:false});
  await assert.rejects(expenses.create(other,user,{...base,locationId:second.location.id,requestKey:crypto.randomUUID()}),/switched off/);
  // Money returned by a supplier belongs in the drawer as well as the report.
  const supplier=await service.createContact(business,user,{kind:'supplier',name:'Stock supplier'});
  const zeroTax=await one('SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=0 LIMIT 1',[business.id]);
  const sku=await service.createCatalog(business,user,{kind:'goods',name:'Test item',code:'TEST-STOCK',unit:'each',price:'10',taxRateId:zeroTax.id,tracking:'quantity'});
  const purchase=await service.document(business,user,{kind:'purchase',locationId:first.location.id,contactId:supplier.id,requestKey:crypto.randomUUID(),lines:[{skuId:sku.id,quantity:'5',unitPrice:'10'}],payment:{method:'cash',amount:'full'}});
  const detail=await service.detail(business,purchase.id);
  const returns=require('../../src/modules/business/core/services/businessReturns.service');
  await returns.createReturn(business,user,purchase.id,{reason:'Damaged item',requestKey:crypto.randomUUID(),lines:[{lineId:detail.lines[0].id,quantity:'1'}]});
  await returns.refund(business,user,purchase.id,{amount:'10',method:'cash',reason:'Supplier returned payment',requestKey:crypto.randomUUID()});
  const supplierMoney=await takings.takings(business,range);
  assert.equal(supplierMoney.received.fromSuppliers,'10.00');
  assert.equal(supplierMoney.suppliers.cash,'50.00');
  assert.equal(supplierMoney.cashInHand,'-130.01');
  const purchaseReport=await service.reports(business,{...range,location:first.location.id});
  assert.equal(purchaseReport.rows.find(r=>r.kind==='purchase_refund').total,'10.00');
});
