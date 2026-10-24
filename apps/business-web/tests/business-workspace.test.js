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
  for(const type of ['general_retail','hardware','agri_inputs','optical','garage','jewellery','fuel_station'])assert.ok(menu(type).some(l=>l.section==='counter'),`${type}: Quick bill`);
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
  // A farm-input shop's own area keeps its name (Farm inputs › Molecules) and holds its four pages;
  // its bill checks and every shop's licences sit with Settings.
  const farm=menu('agri_inputs').find(l=>l.section==='farmers');
  assert.equal(farm.label,'Farm inputs');
  assert.deepEqual(farm.pages.map(p=>p.to.split('/').pop()),['farmers','agri-subsidy','agri-registers','molecules']);
  assert.equal(workspaceFor('molecules','agri_inputs'),'farm');
  assert.ok(!menu('agri_inputs',m=>m!=='agri').some(l=>l.section==='farmers'),'no farm area while the module is off');
  for(const type of ['grocery','hardware','optical'])assert.ok(!typeAllows(sectionRule('farmers',type),type),`${type}: no farm inputs`);
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
