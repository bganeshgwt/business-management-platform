import {test} from 'node:test';
import assert from 'node:assert/strict';
import {businessMenu,sectionRule,typeAllows} from '../src/services/businessNav.js';
import {restaurantMenu,restaurantRelated} from '../src/services/restaurantWorkspace.js';
import {workspaceFor,workspaceSections} from '../src/services/businessWorkspace.js';

const TYPES=['grocery','supermarket','wholesale','fashion','electronics','pharmacy','books','salon','healthcare','meat','weight_retail',
  'general_retail','hardware','agri_inputs','optical','garage','jewellery','fuel_station','memberships','laundry','rentals','lodging'];
test('daily menus keep specialist pages in their trades and remove duplicate setup/task destinations',()=>{
  for(const type of TYPES){
    const links=businessMenu(33,type,()=>true,()=>true).flatMap(group=>group.links);
    assert.equal(new Set(links.map(link=>link.to)).size,links.length,`${type}: duplicate destination`);
    assert.ok(links.length<=16,`${type}: sidebar is too broad`);
    assert.ok(!links.some(link=>['collections','units','movements','counts','labels','roles'].includes(link.section)),`${type}: related tools leaked into sidebar`);
    // Tasks is one Management entry when the business switched it on, and absent otherwise.
    const management=businessMenu(33,type,()=>true,()=>true).find(group=>group.title==='Management').links;
    assert.equal(links.filter(link=>link.section.startsWith('tasks')).length,1,`${type}: one Tasks entry`);
    assert.ok(management.some(link=>link.section==='tasks'&&link.label==='Tasks'),`${type}: Tasks under Management`);
    const off=businessMenu(33,type,()=>true,m=>!['tasks','issues','projects'].includes(m)).flatMap(group=>group.links);
    assert.ok(!off.some(link=>link.section.startsWith('tasks')),`${type}: no Tasks entry while it is switched off`);
    // Quick access and "Jump to…" still reach every page of an area.
    assert.ok(links.flatMap(link=>link.pages).some(page=>page.to.endsWith('/movements')),`${type}: movements reachable`);
    for(const link of links)assert.ok(typeAllows(sectionRule(link.section,type),type),`${type}: foreign trade page`);
  }
  assert.ok(!workspaceSections('stock','grocery').includes('weight-stock'));
  assert.ok(!workspaceSections('products','meat').includes('kits'));
  assert.ok(workspaceSections('stock','pharmacy').includes('pharmacy-batches'));
  assert.ok(!workspaceSections('stock','pharmacy').includes('near-expiry'));
  assert.equal(businessMenu(33,'pharmacy',()=>true,()=>true).flatMap(g=>g.links).filter(l=>['rx-sale','counter'].includes(l.section)).length,1);
  assert.ok(workspaceSections('products','grocery').includes('offers'),'Optional offers remain accessible within Products');
  assert.ok(workspaceSections('orders','wholesale').includes('routes'),'Existing wholesale routes retain a destination');
  assert.ok(workspaceSections('products','meat').includes('pricing'),'Customer rates remain available for weight shops');
  assert.ok(!workspaceSections('products','wholesale').includes('pricing'),'Wholesale pricing belongs to Sales orders');
  for(const type of ['grocery','supermarket','pharmacy'])assert.ok(workspaceSections('products',type).includes('pricing'),`${type}: switched-on price lists are reachable`);
  for(const type of ['meat','weight_retail'])assert.ok(!workspaceSections('stock',type).includes('counts'),`${type}: weighed stock is not counted in pieces`);
  assert.equal(workspaceFor('appointments','electronics'),'repairs');
  assert.equal(workspaceFor('customers','healthcare'),'patients');
  // The newer trades: bookings for the optician, the garage and the gym; a hardware shop's
  // site orders while Sales orders is on; services bill without a counter; their own words.
  // A permission counts only while its module is on, as the business context reports it.
  const menu=(type,has=()=>true)=>businessMenu(33,type,p=>has(p.split('.')[0]),has).flatMap(g=>g.links);
  for(const type of ['optical','garage','memberships'])assert.ok(menu(type).some(l=>l.section==='appointments'),`${type}: bookings in the daily menu`);
  assert.ok(menu('hardware').some(l=>l.section==='sales-orders'),'hardware: site orders');
  assert.ok(!menu('hardware',m=>m!=='sales_orders').some(l=>l.section==='sales-orders'),'hardware: no orders while Sales orders is off');
  for(const type of ['memberships','laundry','rentals','lodging'])assert.ok(!menu(type).some(l=>l.section==='counter'),`${type}: no Quick bill`);
  for(const type of ['general_retail','hardware','agri_inputs','optical','garage','fuel_station'])assert.ok(menu(type).some(l=>l.section==='counter'),`${type}: Quick bill`);
  // A jeweller's counter is the jewellery bill, with Quick bill beside it for everything else.
  assert.ok(menu('jewellery').some(l=>l.section==='jewellery-bill'&&l.pages.some(p=>p.to.endsWith('/counter'))),'jewellery: the jewellery bill with Quick bill');
  assert.ok(menu('jewellery',m=>m!=='jewellery').some(l=>l.section==='counter'),'jewellery: Quick bill while its tools are off');
  assert.equal(menu('hardware').find(l=>l.section==='udhaar').label,'Udhaar');
  assert.equal(menu('optical').find(l=>l.section==='udhaar').label,'Customer dues');
  assert.equal(menu('lodging').find(l=>l.section==='sales').label,'Bill history');
  // Quotations sit with Sales wherever the module is on; a hardware shop's orders have no beat screen.
  const pages=(type,has=()=>true)=>menu(type,has).flatMap(l=>l.pages);
  for(const type of ['hardware','grocery','garage','wholesale'])assert.ok(pages(type).some(p=>p.to.endsWith('/quotations')),`${type}: quotations under Sales`);
  assert.ok(!pages('hardware',m=>m!=='quotations').some(p=>p.to.endsWith('/quotations')),'no quotations while the module is off');
  assert.equal(workspaceFor('quotations','hardware'),'sales');
  assert.ok(!workspaceSections('orders','hardware').includes('routes'),'hardware: no routes and salespeople');
  assert.ok(workspaceSections('orders','wholesale').includes('routes'));
  // A hardware shop's sites sit with its customers; no other trade has them.
  assert.equal(workspaceFor('sites','hardware'),'customers');
  assert.ok(pages('hardware').some(p=>p.to.endsWith('/sites')),'hardware: sites with customers');
  assert.ok(!pages('hardware',m=>m!=='hardware_sites').some(p=>p.to.endsWith('/sites')),'no sites while the module is off');
  for(const type of ['grocery','wholesale','garage'])assert.ok(!typeAllows(sectionRule('sites',type),type),`${type}: no sites`);
  // Its fitters sit with its customers too, and their commission with the reports.
  assert.equal(workspaceFor('fitters','hardware'),'customers');
  // A paint shop's tinting board sits with its sales while Paint tinting is on; no other trade has it.
  assert.equal(workspaceFor('tinting','hardware'),'sales');
  assert.ok(pages('hardware').some(p=>p.to.endsWith('/tinting')),'hardware: paint tinting under Sales');
  assert.ok(!pages('hardware',m=>m!=='hardware_tinting').some(p=>p.to.endsWith('/tinting')),'no tinting while the module is off');
  assert.ok(!pages('grocery').some(p=>p.to.endsWith('/tinting')),'grocery: no paint tinting');
  assert.equal(workspaceFor('fitter-reports','hardware'),'reports');
  for(const end of ['/fitters','/fitter-reports'])assert.ok(pages('hardware').some(p=>p.to.endsWith(end)),`hardware: ${end}`);
  assert.ok(!pages('hardware',m=>m!=='fitter_commission').some(p=>/\/fitter/.test(p.to)),'no fitters while the module is off');
  for(const type of ['grocery','salon','garage'])assert.ok(!typeAllows(sectionRule('fitters',type),type),`${type}: no fitters`);
  // Today's rates: a hardware shop's own board while it is on, and a weight shop's.
  assert.ok(pages('hardware').some(p=>p.to.endsWith('/rates')),'hardware: the rate board with products');
  assert.ok(!pages('hardware',m=>m!=='hardware_rates').some(p=>p.to.endsWith('/rates')),'no board while it is off');
  assert.equal(sectionRule('rates','hardware').module,'hardware_rates');
  assert.equal(sectionRule('rates','meat').module,'weight');
  assert.ok(!typeAllows(sectionRule('rates','grocery'),'grocery'),'grocery: no rate board');
  // A farm-input shop's own area keeps its name (Farm inputs › Molecules) and holds its six pages;
  // its bill checks and every shop's licences sit with Settings.
  const farm=menu('agri_inputs').find(l=>l.section==='farmers');
  assert.equal(farm.label,'Farm inputs');
  assert.deepEqual(farm.pages.map(p=>p.to.split('/').pop()),['farmers','agri-subsidy','agri-registers','molecules','agri-seasons','agri-crops']);
  assert.equal(workspaceFor('molecules','agri_inputs'),'farm');
  assert.ok(!menu('agri_inputs',m=>m!=='agri').some(l=>l.section==='farmers'),'no farm area while the module is off');
  for(const type of ['grocery','hardware','optical'])assert.ok(!typeAllows(sectionRule('farmers',type),type),`${type}: no farm inputs`);
  // Its seed lots and stock kept apart sit with Stock, its company schemes with Purchases, while the module is on.
  assert.deepEqual(['agri-seed-lots','agri-kept-apart','agri-schemes'].map(s=>workspaceFor(s,'agri_inputs')),['stock','stock','purchases']);
  for(const s of ['agri-seed-lots','agri-kept-apart','agri-schemes'])assert.ok(pages('agri_inputs').some(p=>p.to.endsWith(`/${s}`))&&!pages('agri_inputs',m=>m!=='agri').some(p=>p.to.endsWith(`/${s}`))&&!pages('hardware').some(p=>p.to.endsWith(`/${s}`)),s);
  assert.equal(workspaceFor('licences','optical'),'settings');
  for(const type of ['agri_inputs','optical','grocery'])assert.ok(pages(type).some(p=>p.to.endsWith('/licences')),`${type}: licences under Settings`);
  assert.ok(!pages('optical',m=>m!=='licences').some(p=>p.to.endsWith('/licences')),'no licences page while the tool is off');
  assert.ok(pages('agri_inputs').some(p=>p.to.endsWith('/agri-settings')),'agri_inputs: its checks under Settings');
  assert.ok(!pages('hardware').some(p=>p.to.endsWith('/agri-settings')),'hardware: no farm input checks');
  // An optician's spectacle orders are a daily entry of their own; its prescriptions and recall list sit with its customers.
  const spectacles=menu('optical').find(l=>l.section==='spectacle-orders');
  assert.equal(spectacles.label,'Spectacle orders');
  assert.ok(businessMenu(33,'optical',()=>true,()=>true).find(g=>g.title==='Daily work').links.some(l=>l.section==='spectacle-orders'),'optical: spectacle orders in the daily menu');
  assert.deepEqual(menu('optical').find(l=>l.section==='customers').pages.map(p=>p.to.split('/').pop()).filter(s=>['prescriptions','recall'].includes(s)),['prescriptions','recall']);
  assert.equal(workspaceFor('prescriptions','optical'),'customers');
  assert.equal(workspaceFor('spectacle-orders','optical'),'spectacles');
  assert.ok(!menu('optical',m=>m!=='optical').some(l=>l.section==='spectacle-orders'),'no spectacle orders while the module is off');
  assert.ok(!pages('optical',m=>m!=='optical').some(p=>/\/(prescriptions|recall)$/.test(p.to)),'no prescriptions or recall while the module is off');
  for(const type of ['grocery','pharmacy','garage'])for(const section of ['spectacle-orders','prescriptions','recall'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A garage's job cards are a daily entry of their own; its vehicles and service-due list sit with its customers, its settings under Settings.
  const jobCards=menu('garage').find(l=>l.section==='job-cards');
  assert.equal(jobCards.label,'Job cards');
  assert.ok(businessMenu(33,'garage',()=>true,()=>true).find(g=>g.title==='Daily work').links.some(l=>l.section==='job-cards'),'garage: job cards in the daily menu');
  assert.deepEqual(menu('garage').find(l=>l.section==='customers').pages.map(p=>p.to.split('/').pop()).filter(s=>['vehicles','service-due'].includes(s)),['vehicles','service-due']);
  assert.equal(workspaceFor('vehicles','garage'),'customers');
  assert.equal(workspaceFor('job-cards','garage'),'jobCards');
  assert.equal(workspaceFor('garage-settings','garage'),'settings');
  assert.ok(pages('garage').some(p=>p.to.endsWith('/garage-settings')),'garage: its settings under Settings');
  assert.ok(!menu('garage',m=>m!=='garage').some(l=>l.section==='job-cards'),'no job cards while the module is off');
  assert.ok(!pages('garage',m=>m!=='garage').some(p=>/\/(vehicles|service-due|garage-settings)$/.test(p.to)),'no vehicles, service due or garage settings while the module is off');
  // A mechanic (works on job cards, without garage.view) finds the job cards and none of the desk's garage pages.
  const mechanic=new Set(['garage.edit','garage.print','catalog.view','inventory.view','appointments.view']);
  const bench=businessMenu(33,'garage',p=>mechanic.has(p),()=>true).flatMap(g=>g.links);
  assert.ok(bench.some(l=>l.section==='job-cards'),'a mechanic finds the job cards');
  assert.ok(!bench.flatMap(l=>l.pages).some(p=>/\/(vehicles|service-due|garage-settings)$/.test(p.to)),'a mechanic has no vehicles, service due or garage settings');
  for(const type of ['grocery','optical','hardware'])for(const section of ['job-cards','vehicles','service-due','garage-settings'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A gym's check-in desk is a daily entry of its own; its members (with their renewals and the contacts behind them)
  // take the place of customers; its plans sit under Settings.
  const checkIn=menu('memberships').find(l=>l.section==='check-in');
  assert.equal(checkIn.label,'Check-in');
  assert.ok(businessMenu(33,'memberships',()=>true,()=>true).find(g=>g.title==='Daily work').links.some(l=>l.section==='check-in'),'memberships: check-in in the daily menu');
  const members=menu('memberships').find(l=>l.section==='members');
  assert.equal(members.label,'Members');
  assert.deepEqual(members.pages.slice(0,3).map(p=>[p.to.split('/').pop(),p.label]),[['members','Members'],['renewals','Renewals'],['customers','Member contacts']]);
  assert.ok(!menu('memberships').some(l=>l.section==='customers'),'memberships: members in place of customers');
  assert.equal(workspaceFor('customers','memberships'),'members');
  assert.equal(workspaceFor('renewals','memberships'),'members');
  assert.equal(workspaceFor('check-in','memberships'),'checkIn');
  assert.equal(workspaceFor('member-plans','memberships'),'settings');
  assert.ok(pages('memberships').some(p=>p.to.endsWith('/member-plans')),'memberships: its plans under Settings');
  assert.ok(!menu('memberships',m=>m!=='member_plans').some(l=>['check-in','members'].includes(l.section)),'no check-in or members while the module is off');
  assert.equal(menu('memberships',m=>m!=='member_plans').find(l=>l.section==='customers').label,'Member contacts');
  // A trainer (members, their plans and check-ins; no money) finds the desk and the members, and no money screens.
  const trainer=new Set(['member_plans.view','member_plans.create','appointments.view','appointments.edit']);
  const floor=businessMenu(33,'memberships',p=>trainer.has(p),()=>true).flatMap(g=>g.links);
  assert.ok(floor.some(l=>l.section==='check-in')&&floor.some(l=>l.section==='members'),'a trainer finds the desk and the members');
  assert.ok(!floor.some(l=>['sales','udhaar','outstanding','day-close'].includes(l.section)),'a trainer has no money screens');
  for(const type of ['grocery','salon','garage'])for(const section of ['check-in','members','renewals','member-plans'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A laundry's counter: New order and its Orders (with Ready & racks, Unclaimed and Claims) are daily entries of their own; its price list sits with its services, its packages with its customers.
  const daily=businessMenu(33,'laundry',()=>true,()=>true).find(g=>g.title==='Daily work').links;
  assert.deepEqual(daily.slice(1,3).map(l=>[l.section,l.label]),[['laundry-new','New order'],['garment-orders','Orders']]);
  assert.deepEqual(daily.find(l=>l.section==='garment-orders').pages.map(p=>p.label),['Orders','Ready & racks','Unclaimed','Claims']);
  assert.equal(workspaceFor('laundry-packages','laundry'),'customers');
  assert.ok(pages('laundry').some(p=>p.to.endsWith('/laundry-packages')&&p.label==='Packages'),'laundry: its packages with its customers');
  assert.equal(workspaceFor('ready-racks','laundry'),'garmentOrders');
  assert.equal(workspaceFor('laundry-prices','laundry'),'products');
  assert.equal(menu('laundry').find(l=>l.section==='products').label,'Services & items');
  assert.ok(pages('laundry').some(p=>p.to.endsWith('/laundry-prices')&&p.label==='Price list'),'laundry: its price list with its services');
  assert.ok(!menu('laundry',m=>m!=='laundry').some(l=>['laundry-new','garment-orders'].includes(l.section)),'no garment orders while the module is off');
  // The presser (a stock keeper) finds the orders and the racks, and no counter.
  const press=new Set(['laundry.view','laundry.edit','catalog.view','inventory.view']);
  const work=businessMenu(33,'laundry',p=>press.has(p),()=>true).flatMap(g=>g.links);
  assert.ok(work.some(l=>l.section==='garment-orders')&&!work.some(l=>l.section==='laundry-new'),'a presser finds the orders, not the counter');
  for(const type of ['grocery','salon','memberships'])for(const section of ['laundry-new','garment-orders','ready-racks','unclaimed','laundry-prices'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A jeweller's day: today's rates (with the rate board) are a daily entry; prices are for those who see sales.
  const jdaily=businessMenu(33,'jewellery',()=>true,()=>true).find(g=>g.title==='Daily work').links;
  assert.ok(jdaily.some(l=>l.section==='gold-rates'&&l.label==="Today's rates"&&l.pages.some(p=>p.to.endsWith('/rate-board'))),'jewellery: today\'s rates with the board');
  assert.equal(workspaceFor('rate-board','jewellery'),'goldRates');
  const goldsmith=new Set(['jewellery.view','jewellery.edit','catalog.view','inventory.view']);
  assert.ok(!businessMenu(33,'jewellery',p=>goldsmith.has(p),()=>true).flatMap(g=>g.links).some(l=>['gold-rates','old-gold','sales','day-close'].includes(l.section)),'a karigar sees no rates and no money');
  for(const type of ['grocery','laundry','optical'])for(const section of ['gold-rates','rate-board','old-gold'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // Old gold bought or taken in exchange, and gold schemes, are daily entries of their own; the scheme plans are in Settings.
  assert.ok(jdaily.some(l=>l.section==='old-gold'&&l.label==='Old gold'),'jewellery: old gold in its day');
  assert.equal(workspaceFor('old-gold','jewellery'),'oldGold');
  assert.ok(jdaily.some(l=>l.section==='gold-schemes'&&l.label==='Gold schemes'),'jewellery: gold schemes in its day');
  assert.ok(pages('jewellery').some(p=>p.to.endsWith('/scheme-plans')),'jewellery: its scheme plans in Settings');
  assert.ok(!businessMenu(33,'jewellery',p=>goldsmith.has(p),()=>true).flatMap(g=>g.links).some(l=>['gold-schemes','old-gold'].includes(l.section)),'a karigar sees no schemes');
  for(const type of ['grocery','laundry'])for(const section of ['gold-schemes','scheme-plans','cash-report'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // The cash report sits with the reports, for whoever may export it.
  assert.equal(workspaceFor('cash-report','jewellery'),'reports');
  assert.ok(pages('jewellery').some(p=>p.to.endsWith('/cash-report')),'jewellery: the cash report');
  assert.ok(!businessMenu(33,'jewellery',p=>p!=='jewellery.export',()=>true).flatMap(g=>g.links).flatMap(l=>l.pages).some(p=>p.to.endsWith('/cash-report')),'no export, no cash report');
  // Its stock opens on Pieces & tags (its serial numbers are its tags); its settings have a page of their own.
  const jstock=menu('jewellery').find(l=>l.section==='pieces');
  assert.ok(jstock&&jstock.label==='Pieces & tags'&&jstock.pages.some(p=>p.to.endsWith('/movements'))&&!jstock.pages.some(p=>p.to.endsWith('/serials')),'jewellery: pieces first in stock');
  assert.ok(pages('jewellery').some(p=>p.to.endsWith('/jewellery-settings')),'jewellery: its settings');
  assert.ok(businessMenu(33,'jewellery',p=>goldsmith.has(p),()=>true).flatMap(g=>g.links).some(l=>l.section==='pieces'),'a karigar finds the pieces');
  assert.ok(menu('electronics').some(l=>l.pages.some(p=>p.to.endsWith('/serials'))),'others keep the serial register');
  for(const type of ['grocery','electronics'])assert.ok(!typeAllows(sectionRule('pieces',type),type),`${type}: no pieces`);
  // Its karigars' work, the hallmarking centre and the fine-weight book are pages of its stock; custom orders and approvals of its sales; the metal account of its purchases.
  assert.ok(['/karigar-work','/hallmarking','/fine-weight'].every(end=>jstock.pages.some(p=>p.to.endsWith(end))),'jewellery: karigar work, hallmarking and fine weight with the pieces');
  const jsales=menu('jewellery').find(l=>l.section==='sales');
  assert.ok(jsales&&['/custom-orders','/approvals'].every(end=>jsales.pages.some(p=>p.to.endsWith(end))),'jewellery: custom orders and approvals with its sales');
  assert.ok(menu('jewellery').find(l=>l.section==='purchases').pages.some(p=>p.to.endsWith('/metal-account')),'jewellery: the metal account with its purchases');
  const smith=businessMenu(33,'jewellery',p=>goldsmith.has(p),()=>true).flatMap(g=>g.links).flatMap(l=>l.pages);
  assert.ok(smith.some(p=>p.to.endsWith('/karigar-work'))&&!smith.some(p=>/\/(approvals|metal-account)$/.test(p.to)),'a karigar finds the karigar work, not the approvals or the metal account');
  for(const type of ['grocery','electronics','optical'])for(const section of ['custom-orders','approvals','karigar-work','hallmarking','fine-weight','metal-account'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A rental business's day: Bookings (with the availability week and the deposits held) is a daily entry of its own; its products open on its rental items.
  const rdaily=businessMenu(33,'rentals',()=>true,()=>true).find(g=>g.title==='Daily work').links;
  assert.deepEqual(rdaily.slice(1,2).map(l=>[l.section,l.label]),[['rental-bookings','Bookings']]);
  assert.deepEqual(rdaily.find(l=>l.section==='rental-bookings').pages.map(p=>p.label),['Bookings','Availability','Deposits held','Yard & fleet','Hirer register','Use & earnings']);
  assert.equal(workspaceFor('rental-yard','rentals'),'rentalBookings');
  assert.equal(workspaceFor('rental-availability','rentals'),'rentalBookings');
  assert.equal(workspaceFor('rental-items','rentals'),'products');
  const rproducts=menu('rentals').find(l=>l.section==='rental-items');
  assert.ok(rproducts&&rproducts.label==='Rental items'&&rproducts.pages.some(p=>p.to.endsWith('/products')),'rentals: rental items first in products');
  assert.ok(!menu('rentals',m=>m!=='rentals').some(l=>['rental-bookings','rental-items'].includes(l.section)),'no bookings while the module is off');
  // The yard (a stock keeper) finds the bookings and the week, and no money.
  const yard=new Set(['rentals.view','rentals.edit','rentals.print','catalog.view','inventory.view']);
  const yardLinks=businessMenu(33,'rentals',p=>yard.has(p),()=>true).flatMap(g=>g.links);
  assert.ok(yardLinks.some(l=>l.section==='rental-bookings'&&!l.pages.some(p=>p.to.endsWith('/rental-deposits'))),'the yard finds the bookings, not the deposits');
  assert.ok(yardLinks.find(l=>l.section==='rental-bookings').pages.some(p=>p.to.endsWith('/rental-register')),'the yard prints the hirer register');
  assert.ok(!businessMenu(33,'rentals',p=>p==='rentals.view',()=>true).flatMap(g=>g.links).find(l=>l.section==='rental-bookings').pages.some(p=>p.to.endsWith('/rental-register')),'a viewer does not print the register');
  for(const type of ['grocery','laundry','garage'])for(const section of ['rental-bookings','rental-availability','rental-deposits','rental-items','rental-yard','rental-register','rental-reports'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A fuel station's day: Shift & readings, and Tanks & dips (with the tanker receipts and the stock register), after Quick bill; its fleet statements sit with its customers, its pumps and nozzles in Settings.
  const fdaily=businessMenu(33,'fuel_station',()=>true,()=>true).find(g=>g.title==='Daily work').links;
  assert.deepEqual(fdaily.slice(1,4).map(l=>[l.section,l.label]),[['counter','Quick bill'],['fuel-shifts','Shift & readings'],['fuel-dips','Tanks & dips']]);
  assert.deepEqual(fdaily.find(l=>l.section==='fuel-dips').pages.map(p=>p.label),['Tanks & dips','Tanker receipts','Stock register','Registers & inspections']);
  assert.deepEqual(fdaily.find(l=>l.section==='fuel-shifts').pages.map(p=>p.label),['Shift & readings','Attendants\' accounts']);
  assert.ok(menu('fuel_station').find(l=>l.section==='reports').pages.some(p=>p.to.endsWith('/fuel-outlets')),'fuel: every outlet at a glance with the reports');
  assert.equal(workspaceFor('fuel-receipts','fuel_station'),'fuelTanks');
  assert.ok(menu('fuel_station').find(l=>l.section==='customers').pages.some(p=>p.to.endsWith('/fuel-fleet')),'fuel: fleet statements with the customers');
  assert.ok(menu('fuel_station').find(l=>l.label==='Settings').pages.some(p=>p.label==='Pumps & nozzles'),'fuel: pumps and nozzles in Settings');
  assert.ok(!menu('fuel_station',m=>m!=='fuel').some(l=>l.pages.some(p=>/\/fuel-/.test(p.to))),'no fuel screens while the module is off');
  // The pump attendant: their own shifts and the dips; no fleet money and no settings.
  const dsm=new Set(['fuel.view','fuel.create']);
  const dsmLinks=businessMenu(33,'fuel_station',p=>dsm.has(p),()=>true).flatMap(g=>g.links);
  assert.ok(dsmLinks.some(l=>l.section==='fuel-shifts')&&dsmLinks.some(l=>l.section==='fuel-dips'),'the attendant finds the shifts and the dips');
  assert.ok(!dsmLinks.flatMap(l=>l.pages).some(p=>/\/(fuel-fleet|fuel-pumps|fuel-attendants|settings)$/.test(p.to)),'the attendant has no fleet money, no one\'s account and no settings');
  for(const type of ['grocery','garage','rentals'])for(const section of ['fuel-shifts','fuel-dips','fuel-receipts','fuel-register','fuel-fleet','fuel-pumps','fuel-attendants','fuel-records','fuel-outlets'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
  // A lodging business's day: the Front desk (with the rooms, the reservations calendar and every stay) and the foreign guests (with the guest register); its room types and rates in Settings.
  const ldaily=businessMenu(33,'lodging',()=>true,()=>true).find(g=>g.title==='Daily work').links;
  assert.deepEqual(ldaily.slice(1,3).map(l=>[l.section,l.label]),[['lodging-desk','Front desk'],['lodging-form-iii','Foreign guests (Form-III)']]);
  assert.deepEqual(ldaily.find(l=>l.section==='lodging-desk').pages.map(p=>p.label),['Front desk','Rooms & housekeeping','Reservations','Stays','Maintenance']);
  assert.ok(menu('lodging').find(l=>l.section==='reports').pages.some(p=>p.label==='Occupancy & revenue'),'lodging: occupancy, ADR and RevPAR in Reports');
  assert.deepEqual(ldaily.find(l=>l.section==='lodging-form-iii').pages.map(p=>p.label),['Foreign guests (Form-III)','Guest register']);
  assert.equal(workspaceFor('lodging-reservations','lodging'),'lodgingDesk');
  assert.equal(workspaceFor('lodging-register','lodging'),'lodgingGuests');
  assert.ok(menu('lodging').find(l=>l.label==='Settings').pages.some(p=>p.label==='Room types & rates'),'lodging: room types and rates in Settings');
  assert.ok(!menu('lodging',m=>m!=='lodging').some(l=>l.pages.some(p=>/\/lodging-/.test(p.to))),'no lodging screens while the module is off');
  // Housekeeping: the rooms board first; no front desk, no guests' IDs, no money.
  const keeping=new Set(['lodging.view','lodging.edit']);
  const keepingLinks=businessMenu(33,'lodging',p=>keeping.has(p),()=>true).flatMap(g=>g.links);
  assert.equal(keepingLinks.find(l=>l.section==='lodging-rooms')?.label,'Rooms & housekeeping');
  assert.ok(!keepingLinks.flatMap(l=>l.pages).some(p=>/\/(lodging-desk|lodging-form-iii|lodging-register|sales|day-close)$/.test(p.to)),'housekeeping: the rooms only');
  // The front desk: the desk, the stays and Form-III, the register; no settings to change.
  const desk=new Set(['lodging.view','lodging.create','lodging.edit','lodging.cancel','lodging.print','catalog.view','contacts.view','contacts.create','sales.view','sales.create','sales.edit']);
  const deskPages=businessMenu(33,'lodging',p=>desk.has(p),()=>true).flatMap(g=>g.links).flatMap(l=>l.pages);
  for(const section of ['lodging-desk','lodging-rooms','lodging-reservations','lodging-stays','lodging-form-iii','lodging-register'])assert.ok(deskPages.some(p=>p.to.endsWith(`/${section}`)),`the front desk finds ${section}`);
  for(const type of ['grocery','rentals','fuel_station'])for(const section of ['lodging-desk','lodging-rooms','lodging-reservations','lodging-stays','lodging-form-iii','lodging-register','lodging-rates'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
});
test('restricted roles get a permitted destination even when the first workspace page is unavailable',()=>{
  const permissions=new Set(['purchasing.view','contacts.view','inventory.view','catalog.view']);
  const links=businessMenu(1,'meat',p=>permissions.has(p),()=>true).flatMap(g=>g.links);
  assert.ok(links.some(link=>link.section==='stock'));
  assert.ok(links.some(link=>link.section==='purchases'));
  assert.ok(!links.some(link=>['counter','day-close','expenses','udhaar','sales'].includes(link.section)));
  const finance=businessMenu(1,'electronics',p=>p==='expenses.view',()=>true).flatMap(g=>g.links);
  assert.ok(finance.some(link=>link.section==='expenses'),'An expense-only role can find its ledger');
});
test('restaurant tools remain reachable within a permission-filtered area',()=>{
  const sections=[{title:'Service',links:[{to:'/orders',label:'Orders'},{to:'/collection',label:'Pickup'}]},
    {title:'Inventory',links:[{to:'/inventory/items',label:'Stock'},{to:'/inventory/stock',label:'Movements'}]},
    {title:'Tasks',links:[{to:'/tasks',label:'My tasks'},{to:'/tasks/issues',label:'Issues'}]},
    {title:'Platform',links:[{to:'/platform/businesses',label:'Businesses'}]}];
  const menu=restaurantMenu(sections);
  assert.equal(menu.some(group=>group.title==='Tasks'),false);
  const tasks=menu.flatMap(group=>group.links).filter(link=>link.to==='/tasks');
  assert.equal(tasks.length,1,'Tasks is one entry');
  assert.equal(tasks[0].label,'Tasks');
  assert.equal(restaurantRelated(menu,'/tasks/issues').length,2);
  assert.equal(menu.find(group=>group.title==='Platform').links.length,1);
  assert.equal(restaurantRelated(menu,'/inventory/stock').length,2);
  assert.equal(restaurantRelated(menu,'/collection').length,2);
});
test('a clinic\'s menu opens its two workspaces, each only for a role that may open it',()=>{
  // A permission counts only while its module is on, as the business context reports it.
  const menu=(perms,has=()=>true)=>businessMenu(33,'healthcare',p=>perms.includes(p)&&has(p.split('.')[0]),has).flatMap(g=>g.links);
  const daily=businessMenu(33,'healthcare',()=>true,()=>true).find(g=>g.title==='Daily work').links;
  assert.deepEqual(daily.slice(1,3).map(l=>[l.section,l.label,l.to]),[['clinic-workspace','Clinic workspace','/clinic/33'],['lab-workspace','Lab workspace','/lab/33']]);
  assert.deepEqual(daily.find(l=>l.section==='lab-workspace').pages.map(p=>p.to),['/lab/33']);
  const sections=(perms,has)=>menu(perms,has).map(l=>l.section).filter(s=>s.endsWith('-workspace'));
  assert.deepEqual(sections(['patients.view','patients.create','lab.view','lab.create']),['clinic-workspace','lab-workspace'],'the front desk');
  assert.deepEqual(sections(['patients.view','patients.view_clinical','patients.edit_clinical','lab.view']),['clinic-workspace','lab-workspace'],'a doctor');
  assert.deepEqual(sections(['lab.view','lab.edit']),['lab-workspace'],'the lab alone');
  assert.deepEqual(sections(['sales.view','reports.view']),[],'neither for a role with no patients or lab');
  assert.deepEqual(sections(['patients.view','lab.view'],m=>m!=='lab'),['clinic-workspace'],'no lab workspace while the lab is off');
  for(const type of ['grocery','pharmacy','salon','lodging'])for(const section of ['clinic-workspace','lab-workspace'])assert.ok(!typeAllows(sectionRule(section,type),type),`${type}: no ${section}`);
});
test('Your plan sits among the settings, for the business\'s owner and the restaurant\'s',()=>{
  for(const type of TYPES){
    const menu=owner=>businessMenu(33,type,()=>true,()=>true,owner).flatMap(g=>g.links);
    const settings=menu(true).find(l=>l.label==='Settings');
    assert.ok(settings.pages.some(p=>p.to==='/business-admin/33/plan'&&p.label==='Your plan'),`${type}: the owner's plan in Settings`);
    assert.equal(settings.to,'/business-admin/33/settings',`${type}: Settings still opens on the business settings`);
    assert.ok(!menu(false).flatMap(l=>l.pages).some(p=>p.to.endsWith('/plan')),`${type}: no plan for a role without full access`);
  }
  assert.equal(workspaceFor('plan','grocery'),'settings');
  assert.ok(sectionRule('plan','grocery').owner,'the page guard knows it is the owner\'s');
  assert.ok(!typeAllows(sectionRule('plan','restaurant'),'restaurant'),'a restaurant\'s plan is its own /plan');
  const restaurant=restaurantMenu([{title:'Restaurant',links:[{to:'/restaurant/settings',label:'Settings'},{to:'/privacy',label:'Personal data'},{to:'/plan',label:'Your plan'}]}]);
  assert.deepEqual(restaurant.flatMap(g=>g.links).find(l=>l.label==='Settings').related.map(l=>l.to),['/restaurant/settings','/privacy','/plan']);
});
