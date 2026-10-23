const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const path=require('node:path');
const {Client}=require('pg');

// Retail: purchase orders for every shop, shelf
// location, member and branch prices, opening hours, coupons, cashier shifts
// and departments with department-tied staff.
test('retail: prices by branch and member, coupons, shifts, departments, reorder', {timeout:300000}, async(t)=>{
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
  process.env.DB_NAME=database;process.env.NODE_ENV='test';process.env.JWT_SECRET=crypto.randomBytes(48).toString('hex');
  const {runner}=await import('node-pg-migrate');
  await runner({databaseUrl:{...connection,database},dir:path.resolve(__dirname,'../../migrations'),migrationsTable:'pgmigrations',direction:'up',count:Infinity,checkOrder:true,log(){}});
  pool=require('../../src/config/database');
  const one=async(sql,args=[])=>(await pool.query(sql,args)).rows[0];
  const restaurant=await one("INSERT INTO restaurants(name,code) VALUES('Retail test','RTLTEST') RETURNING id");
  const owner=await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,'Owner','retail-owner@test.invalid','unused-test-password') RETURNING id,name",[restaurant.id]);
  const cashierUser=await one("INSERT INTO users(restaurant_id,name,email,password_hash) VALUES($1,'Kavya','retail-cashier@test.invalid','unused-test-password') RETURNING id,name",[restaurant.id]);
  const row=await one("INSERT INTO businesses(name,code,business_type,created_by) VALUES('Super','RTL-SUPER','supermarket',$1) RETURNING id",[owner.id]);
  await pool.query('INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by) SELECT $1,$2,id,$2,$2 FROM business_roles WHERE business_id=$1 AND full_access',[row.id,owner.id]);
  const main=await one("INSERT INTO business_locations(business_id,name,code) VALUES($1,'Main store','MAIN') RETURNING id",[row.id]);
  const access=require('../../src/modules/business/core/services/businessAccess.service');
  const service=require('../../src/modules/business/core/services/business.service');
  const setup=require('../../src/modules/business/core/services/businessSetup.service');
  const retail=require('../../src/modules/business/retail/services/businessRetail.service');
  const offers=require('../../src/modules/business/retail/services/businessRetailOffers.service');
  const branchPrices=require('../../src/modules/business/core/services/businessLocationPrices.service');
  const departments=require('../../src/modules/business/core/services/businessDepartments.service');
  const shifts=require('../../src/modules/business/core/services/businessShifts.service');
  const purchases=require('../../src/modules/business/wholesale/services/businessWholesalePurchase.service');
  const repo=require('../../src/modules/business/core/repositories/business.repository');
  const user={id:owner.id,name:owner.name};
  let business=await access.load(user,row.id);
  for(const code of ['offers','loyalty'])if(!business.capabilities.includes(code))await setup.setModule(business,user,code,{enabled:true});
  business=await access.load(user,row.id);
  await pool.query("UPDATE business_settings SET tax_mode='exclusive',rounding='none',walk_in_credit=true WHERE business_id=$1",[row.id]);

  // Opening hours: per day, a day left out is closed; a bad time is refused.
  const branch=await service.createLocation(business,user,{name:'JP Nagar',code:'JPN',openingHours:{mon:{open:'09:00',close:'21:00'},sun:{open:'10:00',close:'14:00'}}});
  assert.deepEqual(branch.opening_hours,{mon:{open:'09:00',close:'21:00'},sun:{open:'10:00',close:'14:00'}});
  await assert.rejects(service.createLocation(business,user,{name:'Bad',code:'BAD',openingHours:{mon:{open:'9am',close:'21:00'}}}),/time like 09:00/);
  const renamed=await service.updateLocation(business,user,branch.id,{name:'JP Nagar branch',active:true});
  assert.deepEqual(renamed.opening_hours,branch.opening_hours,'Hours are kept when not sent');
  business=await access.load(user,row.id);

  // Departments: a top-level category's department; sub-categories follow it.
  const clothing=await departments.create(business,user,{name:'Clothing'});
  const grocery=await departments.create(business,user,{name:'Grocery'});
  await assert.rejects(departments.create(business,user,{name:'clothing'}),/already a department/);
  const apparel=await setup.createCategory(business,user,{name:'Apparel',departmentId:clothing.id});
  const shirts=await setup.createCategory(business,user,{name:'Shirts',parentId:apparel.id});
  assert.equal(String(shirts.department_id),String(clothing.id));
  const staples=await setup.createCategory(business,user,{name:'Staples',departmentId:grocery.id});

  const zeroTax=await one('SELECT id FROM business_tax_rates WHERE business_id=$1 AND rate=0 LIMIT 1',[row.id]);
  const item=(code,name,price,categoryId,extra={})=>service.createCatalog(business,user,{kind:'goods',name,code,unit:'each',price,taxRateId:zeroTax.id,tracking:'quantity',categoryId,...extra});
  const rice=await item('RICE-5','Rice 5 kg',400,staples.id,{shelfLocation:'Aisle 3 · Shelf B',memberPrice:'380',reorderLevel:10,openingStock:{locationId:main.id,quantity:'40',unitCost:'300'}});
  const shirt=await item('SHIRT-M','Shirt M',900,shirts.id,{openingStock:{locationId:main.id,quantity:'5',unitCost:'500'}});
  await assert.rejects(item('X','Bad member',100,staples.id,{memberPrice:'100'}),/member price .* must be below/);
  assert.equal(rice.shelf_location,'Aisle 3 · Shelf B');assert.equal(rice.member_price,'380.00');
  const found=await repo.page(row.id,'catalog',10,0,{search:'Aisle 3'});
  assert.equal(found.total,1,'Searchable by shelf location');

  // Branch price: the branch sells at its own price; the main store at the item's.
  await branchPrices.save(business,user,rice.id,{prices:[{locationId:branch.id,price:'420'}]});
  await assert.rejects(branchPrices.save(business,user,rice.id,{prices:[{locationId:branch.id,price:'0'}]}),/more than zero/);
  const quote=(locationId,extra={})=>retail.quote(business,user,{locationId,lines:[{skuId:rice.id,quantity:'1'}],...extra});
  assert.equal((await quote(branch.id)).lines[0].unitPrice,'420.00');assert.equal((await quote(branch.id)).lines[0].priceKind,'branch');
  assert.equal((await quote(main.id)).lines[0].unitPrice,'400.00');
  assert.deepEqual((await branchPrices.forLocation(business,{location:branch.id})).map(r=>[String(r.sku_id),r.price]),[[String(rice.id),'420.00']]);

  // Member price: a named customer with loyalty on pays it; a walk-in does not.
  const customer=await service.createContact(business,user,{kind:'customer',name:'Asha',phone:'9800000001'});
  const member=await quote(main.id,{contactId:customer.id});
  assert.equal(member.lines[0].unitPrice,'380.00');assert.equal(member.lines[0].priceKind,'member');
  assert.equal((await quote(branch.id,{contactId:customer.id})).lines[0].unitPrice,'380.00','The lower member price beats a higher branch price');

  // Coupons: only with the code; limits on uses.
  const coupon=await offers.createOffer(business,user,{name:'Diwali 50 off',kind:'bill_amount',value:'50',startsOn:'2000-01-01',couponCode:'diwali50',usageLimit:1,perCustomerLimit:1});
  assert.equal(coupon.coupon_code,'DIWALI50');
  await assert.rejects(offers.createOffer(business,user,{name:'Dup',kind:'bill_amount',value:'10',startsOn:'2000-01-01',couponCode:'DIWALI50'}),/used by another offer/);
  await assert.rejects(offers.createOffer(business,user,{name:'Limit alone',kind:'bill_amount',value:'10',startsOn:'2000-01-01',usageLimit:3}),/give a coupon code/);
  assert.equal((await quote(main.id)).savings,'0.00','No code, no coupon');
  await assert.rejects(quote(main.id,{coupon:'NOPE1'}),/no coupon NOPE1/);
  await assert.rejects(quote(main.id,{coupon:'DIWALI50'}),/choose the customer/);
  const withCoupon=await quote(main.id,{coupon:'diwali50',contactId:customer.id});
  assert.equal(withCoupon.coupon.applied,true);assert.equal(withCoupon.total,'330.00');
  const sale=(extra)=>service.document(business,{...user},{kind:'sale',locationId:main.id,requestKey:crypto.randomUUID(),lines:[{skuId:rice.id,quantity:'1'}],payment:{method:'cash',amount:'full'},...extra});
  await sale({contactId:customer.id,coupon:'DIWALI50'});
  await assert.rejects(sale({contactId:customer.id,coupon:'DIWALI50'}),/used up/);

  // Cashier shifts: the count is checked against this cashier's own cash.
  const cashierRole=await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='cashier'",[row.id]);
  await pool.query('INSERT INTO business_memberships(business_id,user_id,role_id,created_by,updated_by) VALUES($1,$2,$3,$4,$4)',[row.id,cashierUser.id,cashierRole.id,owner.id]);
  const cashier=await access.load({id:cashierUser.id},row.id);
  const kavya={id:cashierUser.id,name:cashierUser.name};
  const shift=await shifts.open(cashier,kavya,{locationId:main.id,openingCash:'1000'});
  await assert.rejects(shifts.open(cashier,kavya,{locationId:main.id,openingCash:'500'}),/already open/);
  await service.document(cashier,kavya,{kind:'sale',locationId:main.id,requestKey:crypto.randomUUID(),lines:[{skuId:shirt.id,quantity:'1'}],payment:{method:'cash',amount:'full'}});
  await sale({});// the owner's own sale is not in Kavya's drawer
  const live=await shifts.current(cashier,kavya,{location:main.id});
  assert.equal(live.expected_so_far,'1900.00');
  await assert.rejects(shifts.close(cashier,kavya,shift.id,{countedCash:'1850'}),/50.00 short/);
  const closed=await shifts.close(cashier,kavya,shift.id,{countedCash:'1850',reason:'Gave extra change'});
  assert.equal(closed.difference,'-50.00');assert.equal(closed.expected_cash,'1900.00');
  await assert.rejects(pool.query('UPDATE business_counter_shifts SET counted_cash=1900 WHERE id=$1',[shift.id]),/cannot be changed/);
  await assert.rejects(pool.query('DELETE FROM business_counter_shifts WHERE id=$1',[shift.id]),/permanent records/);
  assert.equal((await shifts.list(business,user,{})).items.length,1);

  // Department-tied staff: products and stock of their department only.
  await access.setMember(business,user,{userId:cashierUser.id,roleId:(await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='manager'",[row.id])).id,workDepartmentId:clothing.id});
  const clothingManager=await access.load({id:cashierUser.id},row.id);
  assert.equal(String(clothingManager.member_department_id),String(clothing.id));
  await assert.rejects(service.updateCatalog(clothingManager,kavya,rice.id,{label:'Rice 5 kg',price:400}),/outside it/);
  await service.updateCatalog(clothingManager,kavya,shirt.id,{label:'Shirt M (cotton)',price:900,shelfLocation:'Rack C'});
  const riceLot=await one('SELECT id FROM business_stock_lots WHERE business_id=$1 AND sku_id=$2 LIMIT 1',[row.id,rice.id]);
  const returns=require('../../src/modules/business/core/services/businessReturns.service');
  await assert.rejects(returns.adjust(clothingManager,kavya,riceLot.id,{quantity:'-1',reason:'Damaged',requestKey:crypto.randomUUID()}),/outside it/);
  const onlyClothing=await repo.page(row.id,'catalog',50,0,{filters:{department:String(clothing.id)}});
  assert.ok(onlyClothing.items.every(i=>String(i.department_id)===String(clothing.id)) && onlyClothing.total===1);
  await assert.rejects(departments.update(business,user,clothing.id,{name:'Clothing',active:false}),/works in Clothing/);

  // A department head makes staff logins in their own department only (Staff &
  // access › New staff login), and no login is left behind when refused.
  const onboarding=require('../../src/modules/business/core/services/businessOnboarding.service');
  const headRole=await access.createRole(business,user,{name:'Department head',permissions:['access.view','access.edit','catalog.view']});
  const helperRole=await access.createRole(business,user,{name:'Helper',permissions:['catalog.view']});
  await access.setMember(business,user,{userId:cashierUser.id,roleId:headRole.id,workDepartmentId:clothing.id});
  const clothingHead=await access.load({id:cashierUser.id},row.id);
  const newLogin=(email,extra)=>onboarding.createStaffAccount(clothingHead,kavya,{name:'Ravi',email,password:crypto.randomBytes(12).toString('hex'),roleId:helperRole.id,...extra});
  await assert.rejects(newLogin('ravi-all@test.invalid',{}),/You work in Clothing/);
  await assert.rejects(newLogin('ravi-grocery@test.invalid',{workDepartmentId:grocery.id}),/You work in Clothing/);
  assert.equal(await one("SELECT id FROM users WHERE email LIKE 'ravi-%'"),undefined,'No login without access');
  const ravi=await newLogin('ravi@test.invalid',{workDepartmentId:clothing.id});
  assert.equal(String(ravi.department_id),String(clothing.id));
  assert.equal(ravi.role_name,'Helper');

  // A new password (Staff & access › Password) keeps to the people Give access
  // reaches: a department head sets one in their own department only (not for
  // someone across every department), and a person tied to a location at that
  // location only (not for someone who works at every location). A refusal
  // changes nothing; the owner reaches everyone.
  const bcrypt=require('bcrypt');
  const staffLogin=(name,extra)=>onboarding.createStaffAccount(business,user,{name,email:`${name.toLowerCase()}@test.invalid`,password:crypto.randomBytes(12).toString('hex'),roleId:helperRole.id,...extra});
  const newPassword=(by,who,staff)=>onboarding.resetStaffPassword(by,who,staff.user_id,{password:'Fresh-pass-2026'});
  const hasNewPassword=async(staff)=>bcrypt.compare('Fresh-pass-2026',(await one('SELECT password_hash FROM users WHERE id=$1',[staff.user_id])).password_hash);
  const gita=await staffLogin('Gita',{workDepartmentId:grocery.id});
  const mohan=await staffLogin('Mohan',{});
  await assert.rejects(newPassword(clothingHead,kavya,gita),{statusCode:403,message:'This person does not work in your department'});
  await assert.rejects(newPassword(clothingHead,kavya,mohan),{statusCode:403,message:'This person does not work in your department'});
  assert.deepEqual(await newPassword(clothingHead,kavya,ravi),{id:ravi.user_id,name:'Ravi'});
  assert.ok(await hasNewPassword(ravi));
  const lata=await staffLogin('Lata',{roleId:headRole.id,workLocationId:branch.id});
  const branchHead=await access.load({id:lata.user_id},row.id);
  const lataUser={id:lata.user_id,name:lata.name};
  const arun=await staffLogin('Arun',{workLocationId:branch.id});
  const meena=await staffLogin('Meena',{workLocationId:main.id});
  await assert.rejects(newPassword(branchHead,lataUser,meena),{statusCode:403,message:'This person does not work at your location'});
  await assert.rejects(newPassword(branchHead,lataUser,mohan),{statusCode:403,message:'This person does not work at your location'});
  await newPassword(branchHead,lataUser,arun);
  assert.ok(await hasNewPassword(arun));
  assert.deepEqual(await Promise.all([gita,mohan,meena].map(hasNewPassword)),[false,false,false]);
  await newPassword(business,user,gita);
  assert.ok(await hasNewPassword(gita));
  // Give access has the same reach: nobody is pulled in from outside it.
  await assert.rejects(access.setMember(clothingHead,kavya,{userId:gita.user_id,roleId:helperRole.id,workDepartmentId:clothing.id}),{statusCode:403,message:'This person does not work in your department'});
  await assert.rejects(access.setMember(branchHead,lataUser,{userId:mohan.user_id,roleId:helperRole.id,workLocationId:branch.id}),{statusCode:403,message:'This person does not work at your location'});

  // The staff list says whom the caller manages, and Staff & access shows
  // Change and Password only there. The Clothing head: Clothing's people
  // whose role does no more than theirs (not Deepa, a manager). The JP Nagar
  // head: the branch's people. The owner: everyone else. Nobody manages the
  // owner or themselves.
  const managerRoleId=(await one("SELECT id FROM business_roles WHERE business_id=$1 AND template_code='manager'",[row.id])).id;
  const deepa=await staffLogin('Deepa',{roleId:managerRoleId,workDepartmentId:clothing.id});
  const manages=async(by)=>Object.fromEntries((await access.markManaged(by,(await repo.page(row.id,'members',100,0,{})).items)).map(m=>[m.name,m.manages]));
  assert.deepEqual(await manages(clothingHead),{Owner:false,Kavya:false,Ravi:true,Deepa:false,Gita:false,Mohan:false,Lata:false,Arun:false,Meena:false});
  assert.deepEqual(await manages(branchHead),{Owner:false,Kavya:false,Ravi:false,Deepa:false,Gita:false,Mohan:false,Lata:false,Arun:true,Meena:false});
  assert.deepEqual(await manages(business),{Owner:false,Kavya:true,Ravi:true,Deepa:true,Gita:true,Mohan:true,Lata:true,Arun:true,Meena:true});
  // The answer is Give access's own: Deepa is out of the Clothing head's reach there too.
  await assert.rejects(access.setMember(clothingHead,kavya,{userId:deepa.user_id,roleId:helperRole.id,workDepartmentId:clothing.id}),
    {statusCode:403,message:/^This person's role can do things yours cannot \(.+\), so you cannot change their access or password$/});

  // Department report: sales, returns and margin by department.
  const report=await departments.report(business,{});
  const groceryRow=report.rows.find(r=>r.department==='Grocery');
  assert.ok(groceryRow && Number(groceryRow.net_sales)>0 && Number(groceryRow.cost)>0 && groceryRow.margin_percent!==null);
  assert.ok(report.rows.some(r=>r.department==='Clothing'));

  // A supplier's scheme: 10 paid + 2 free at 100, 10% trade discount = 900 for 12 units (75 each in stock).
  const supplier=await service.createContact(business,user,{kind:'supplier',name:'Distributor'});
  const bought=await service.document(business,user,{kind:'purchase',locationId:main.id,contactId:supplier.id,requestKey:crypto.randomUUID(),supplierBillNo:'D-1',
    lines:[{skuId:shirt.id,quantity:'10',freeQuantity:'2',discountPercent:'10',unitPrice:'100'}]});
  const boughtLine=await one('SELECT quantity,net,free_quantity,discount_percent,stock_unit_cost FROM business_document_lines WHERE business_id=$1 AND document_id=$2',[row.id,bought.id]);
  assert.deepEqual([boughtLine.quantity,boughtLine.net,boughtLine.free_quantity,boughtLine.discount_percent,boughtLine.stock_unit_cost],['12.000','900.00','2.000','10.00','75.0000']);
  await assert.rejects(service.document(business,user,{kind:'purchase',locationId:main.id,contactId:supplier.id,requestKey:crypto.randomUUID(),supplierBillNo:'D-2',
    lines:[{skuId:shirt.id,quantity:'1',discountPercent:'100',unitPrice:'100'}]}),/Discount %/);
  await assert.rejects(sale({lines:[{skuId:rice.id,quantity:'1',freeQuantity:'1'}]}),/for purchases/);

  // The Overview's picture of the day: two weeks, today's pace, best sellers; nothing for a role without sales.
  const picture=await require('../../src/modules/business/core/services/businessOverview.service').overview(business);
  assert.equal(picture.sales.days.length,14);
  assert.ok(Number(picture.sales.today)>0 && picture.sales.bills_today>0 && picture.sales.top_today.length>0);
  const blind=await require('../../src/modules/business/core/services/businessOverview.service').overview({...business,full_access:false,permissions:['catalog.view']});
  assert.equal(blind.sales,undefined);

  // An item kept only for use in services is never sold.
  const backbar=await item('BACKBAR','Cleaning concentrate (in-house)',50,staples.id,{internalUse:true,openingStock:{locationId:main.id,quantity:'5',unitCost:'20'}});
  assert.equal(backbar.internal_use,true);
  await assert.rejects(sale({lines:[{skuId:backbar.id,quantity:'1'}]}),/use in services only/);

  // Reorder suggestions for a supermarket branch (no wholesale back-orders).
  await service.updateCatalog(business,user,rice.id,{label:'Rice 5 kg',price:400,reorderLevel:'50'});
  const suggested=await purchases.suggestions(business,{location:main.id});
  const line=suggested.items.find(i=>String(i.sku_id)===String(rice.id));
  assert.ok(line && line.reason==='reorder' && Number(line.back_orders)===0 && Number(line.need)>0);
});
