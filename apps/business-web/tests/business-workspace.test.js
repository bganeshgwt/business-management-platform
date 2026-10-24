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
