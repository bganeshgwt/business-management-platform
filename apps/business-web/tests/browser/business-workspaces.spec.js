import {test,expect} from '@playwright/test';

import {business as businessOf,fixture,localDate,signIn} from '../../../../e2e/fixture.mjs';

// The restaurant's admin owns one business of every type (e2e/test-data.mjs),
// each with the specialist tools its trade uses switched on; the meat shop
// sells cuts by weight. Screenshots for the visual review go to each test's
// own folder under test-results.
test.beforeEach(async({page})=>{
  await signIn(page);
  await expect(page.locator('main.content-scroll')).toBeVisible({timeout:30000});
});

test('every local business presents a small menu and accessible stock, settings and report workspaces',async({page})=>{
  test.setTimeout(600000);
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const types=['grocery','supermarket','wholesale','fashion','electronics','pharmacy','books','salon','healthcare','meat','weight_retail','general_retail','hardware','agri_inputs','optical','garage','jewellery','fuel_station','memberships','laundry','rentals','lodging'];
  for(const type of types){
    const business=businessOf(type);
    await page.goto(`/business-admin/${business.id}/settings`);
    await expect(page.getByRole('heading',{name:'Business settings',exact:true})).toBeVisible({timeout:30000});
    const sidebar=page.locator('.sidebar');
    const hrefs=await sidebar.locator('a.nav-link').evaluateAll(links=>links.map(link=>link.getAttribute('href')));
    // Tasks is at most one entry (only when the business switched it on).
    expect(hrefs.filter(h=>/\/tasks(?:\/|$)/.test(h)).length).toBeLessThanOrEqual(1);
    expect(hrefs.filter(h=>/\/(units|tax-rates|roles|collections)$/.test(h))).toHaveLength(0);
    expect(hrefs.length).toBeLessThanOrEqual(16);
    await expect(page.getByRole('navigation',{name:'Related pages'})).toBeVisible();
    await page.goto(`/business-admin/${business.id}/reports`);
    await expect(page.getByRole('heading',{name:'Reports',exact:true})).toBeVisible({timeout:30000});
    await expect(page.getByText('This screen belongs to a different kind of business.')).toHaveCount(0);
    // Today on the business's own clock.
    const result=await page.evaluate(async({id,today})=>{
      const api=await import('/src/services/business.service.js');
      return (await api.businessRead(id,'reports',{from:today,to:today})).rows;
    },{id:business.id,today:localDate()});
    expect(Array.isArray(result)).toBeTruthy();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),`${type} has no page-width overflow`).toBeTruthy();
  }
  expect(errors).toEqual([]);
});

test('meat billing fits desktop, customer dues share navigation, and expense/cash dialogs stay on their page',async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:900});
  const business=businessOf('meat');
  await page.goto(`/business-admin/${business.id}/counter`);
  await expect(page.getByRole('heading',{name:'Quick bill',exact:true})).toBeVisible({timeout:30000});
  await expect(page.getByRole('heading',{name:'Customer',exact:true})).toBeVisible();
  await expect(page.locator('.rt-post')).toBeInViewport();
  await expect(page.getByRole('button',{name:/^Split/})).toHaveCount(0);
  const tenders=await page.locator('.rt-tender .segment').evaluateAll(buttons=>buttons.map(button=>Math.round(button.getBoundingClientRect().top)));
  expect(new Set(tenders).size).toBe(1);
  await page.goto(`/business-admin/${business.id}/stock`);
  await expect(page.getByRole('heading',{name:'Stock on hand',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Stock by weight',exact:true})).toBeVisible();
  await page.goto(`/business-admin/${business.id}/udhaar`);
  await expect(page.getByRole('navigation',{name:'Related pages'}).getByRole('link',{name:'Payments received'})).toBeVisible();
  await page.goto(`/business-admin/${business.id}/expenses`);
  await expect(page.getByRole('heading',{name:'Daily expenses',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Record expense',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto(`/business-admin/${business.id}/day-close`);
  await expect(page.getByRole('heading',{name:'Daily money',exact:true})).toBeVisible();
  const locations=page.getByLabel('Counter / location');
  if(await locations.count()) {
    const value=await locations.locator('option').evaluateAll(options=>options.find(option=>option.value)?.value);
    await locations.selectOption(value);
  }
  await expect(page.getByRole('button',{name:'Count cash',exact:true})).toBeEnabled({timeout:30000});
  await page.getByRole('button',{name:'Count cash',exact:true}).click();
  await expect(page.getByRole('dialog').getByText('Opening cash',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.locator(".modal-backdrop, .motion-backdrop-ghost")).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('daily-money.png'),fullPage:true});
  await page.goto(`/business-admin/${business.id}/counter`);
  await expect(page.locator('.rt-post')).toBeVisible();
  // The shelf holds the shop's cuts.
  await expect(page.locator(".rt-shelf-grid")).toBeVisible();
  await expect(page.locator(".rt-shelf-grid")).toContainText(business.items[0].name);
  await page.screenshot({path:testInfo.outputPath('meat-counter.png')});
});

test('mobile navigation keeps related tools reachable without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const business=businessOf('meat');
  await page.goto(`/business-admin/${business.id}/stock`);
  await expect(page.getByRole('heading',{name:'Stock on hand',exact:true})).toBeVisible({timeout:30000});
  await page.getByRole('button',{name:'More tools',exact:true}).click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
});

test('restaurant stock tools share their area and keep the existing permission-filtered menu',async({page})=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/inventory/items');
  const related=page.getByRole('navigation',{name:'Related pages'});
  await expect(related).toBeVisible({timeout:30000});
  await expect(related.getByRole('link',{name:'Items & stock',exact:true})).toBeVisible();
  await expect(page.locator('.sidebar').getByRole('link',{name:'Stock',exact:true})).toHaveClass(/active/);
  await expect(page.locator('.sidebar').getByRole('link',{name:'My tasks',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
});

test('prescription billing has one payment method and optional offers remain reachable',async({page})=>{
  const pharmacy=businessOf('pharmacy');
  await page.goto(`/business-admin/${pharmacy.id}/rx-sale`);
  await expect(page.getByRole('heading',{name:'Prescription sale',exact:true})).toBeVisible({timeout:30000});
  await expect(page.getByRole('group',{name:'Paid by'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Split',exact:true})).toHaveCount(0);
  const grocery=businessOf('grocery');
  await page.goto(`/business-admin/${grocery.id}/products`);
  await expect(page.getByRole('navigation',{name:'Related pages'})).toBeVisible({timeout:30000});
  const offers=page.getByRole('navigation',{name:'Related pages'}).getByRole('link',{name:'Offers & discounts',exact:true});
  if(await offers.count())await offers.click();
  else{
    await page.getByRole('button',{name:'More tools',exact:true}).click();
    await page.getByRole('menuitem',{name:'Offers & discounts',exact:true}).click();
  }
  await expect(page).toHaveURL(new RegExp(`/business-admin/${grocery.id}/offers$`));
  await expect(page.locator('main.content-scroll h1')).toBeVisible();
});

test('all business main menu destinations render without runtime or API failures',async({page})=>{
  test.setTimeout(600000);
  const failures=[];
  page.on('pageerror',error=>failures.push(error.message));
  page.on('response',response=>{
    if(response.status()>=500&&response.url().includes('/api/')) failures.push(`${response.status()} ${response.url()}`);
  });
  // Every business the restaurant's admin owns: one of each type.
  for(const business of Object.values(fixture().businesses)){
    await page.goto(`/business-admin/${business.id}/settings`);
    await expect(page.getByRole('heading',{name:'Business settings',exact:true})).toBeVisible({timeout:30000});
    const links=await page.locator('.sidebar a.nav-link').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('href')).filter(href=>href.startsWith('/business-admin/')));
    for(const href of links){
      await page.goto(href);
      await expect(page.locator('main.content-scroll h1').first(),href).toBeVisible({timeout:30000});
      await expect(page.getByText('This screen belongs to a different kind of business.',{exact:true})).toHaveCount(0);
      await expect(page.getByText('This tool is turned off for this business.',{exact:true})).toHaveCount(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),href).toBeTruthy();
    }
  }
  expect(failures).toEqual([]);
});

test('related page tabs show selection, work from the keyboard and preserve browser history',async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:900});
  await page.goto('/logbook');
  await expect(page.getByRole('heading',{name:'Log book',exact:true})).toBeVisible({timeout:30000});
  const nav=page.getByRole('navigation',{name:'Related pages'});
  const current=nav.locator('[aria-current="page"]');
  await expect(nav.locator('.bz-workspace-tab svg')).toHaveCount(3);
  await expect(current).toHaveText('Log book');
  expect(await current.evaluate(node=>getComputedStyle(node).borderBottomWidth)).toBe('3px');
  await nav.getByRole('link',{name:'Reports',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  await expect(nav.getByRole('link',{name:'Activity log',exact:true})).toBeFocused();
  await expect(page).toHaveURL(/\/logbook$/);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/reports$/);
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Reports');
  await page.goBack();
  await expect(page.getByRole('heading',{name:'Log book',exact:true})).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Log book');
  await page.getByRole('button',{name:'New entry',exact:true}).first().click();
  const dialog=page.getByRole('dialog',{name:'New log book entry'});
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('textarea[required]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.modal-backdrop, .motion-backdrop-ghost')).toHaveCount(0);
  await page.locator('main.content-scroll').evaluate(node=>{node.scrollTop=0;});
  await expect(nav).toBeInViewport();
  await page.screenshot({path:testInfo.outputPath('tabs-logbook.png')});
});

test('mobile tabs expose overflow and keep a page selected from More tools visible',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  const meat=businessOf('meat');
  await page.goto(`/business-admin/${meat.id}/stock`);
  const nav=page.getByRole('navigation',{name:'Related pages'});
  await expect(nav).toBeVisible({timeout:30000});
  const next=nav.getByRole('button',{name:'Scroll related pages right',exact:true});
  await expect(next).toBeEnabled();
  await next.click();
  await expect.poll(()=>nav.locator('.bz-workspace-tabs').evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
  await nav.getByRole('button',{name:'More tools',exact:true}).click();
  await page.getByRole('menuitem',{name:'Wastage',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/business-admin/${meat.id}/wastage$`));
  const selected=nav.locator('[aria-current="page"]');
  await expect(selected).toHaveText('Wastage');
  await expect.poll(()=>selected.evaluate(node=>{
    const item=node.getBoundingClientRect(),track=node.parentElement.getBoundingClientRect();
    return item.left>=track.left-1&&item.right<=track.right+1;
  })).toBeTruthy();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('tabs-mobile.png')});
});

test('in-page tabs switch the named panel with arrows and retain other query filters',async({page})=>{
  const books=businessOf('books');
  await page.goto(`/business-admin/${books.id}/book-orders?review=keep`);
  const tabs=page.getByRole('tablist',{name:'Booklists and orders'});
  await expect(tabs).toBeVisible({timeout:30000});
  await tabs.getByRole('tab',{name:'Customer orders',exact:true}).focus();
  await page.keyboard.press('ArrowRight');
  const sets=tabs.getByRole('tab',{name:'School sets',exact:true});
  await expect(sets).toHaveAttribute('aria-selected','true');
  await expect(sets).toBeFocused();
  await expect(page.getByRole('tabpanel',{name:'School sets'})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('review')).toBe('keep');
  await page.keyboard.press('Home');
  await expect(page.getByRole('tabpanel',{name:'Customer orders'})).toBeVisible();
  expect(await tabs.locator('[tabindex="0"]').count()).toBe(1);
  const pharmacy=businessOf('pharmacy');
  await page.goto(`/business-admin/${pharmacy.id}/pharmacy-batches`);
  await page.getByRole('tab',{name:'Recalls',exact:true}).click();
  await expect(page.getByRole('tabpanel',{name:'Recalls'})).toBeVisible();
  await expect(page.getByRole('tab',{name:'Recalls',exact:true})).toHaveAttribute('aria-selected','true');
});

test('label selection opens a modal and retains the editable queue after closing',async({page})=>{
  const meat=businessOf('meat');
  await page.goto(`/business-admin/${meat.id}/labels`);
  const add=page.getByRole('button',{name:'Add to sheet',exact:true}).first();
  await expect(add).toBeVisible({timeout:30000});
  await add.click();
  const dialog=page.getByRole('dialog',{name:'Label sheet',exact:true});
  await expect(dialog).toBeVisible();
  const copies=dialog.locator('.rt-copies').first();
  await expect(copies).toHaveValue('1');
  await copies.fill('3');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'Label sheet (3)',exact:true}).click();
  await expect(copies).toHaveValue('3');
  await page.keyboard.press('Escape');
  await add.click();
  await expect(copies).toHaveValue('4');
  await expect(dialog.locator('.rt-copies')).toHaveCount(1);
});

test('Quick bill clears a failed search when the input changes and adds the selected match',async({page})=>{
  const meat=businessOf('meat');
  await page.goto(`/business-admin/${meat.id}/counter`);
  const input=page.getByRole('combobox',{name:'Scan or type an item',exact:true});
  await expect(input).toBeVisible({timeout:30000});
  await input.fill('ZZ-NOT-AN-ITEM-UI-REVIEW');
  await page.getByRole('button',{name:'Add to bill',exact:true}).click();
  await expect(page.getByText(/Nothing matches "ZZ-NOT-AN-ITEM-UI-REVIEW"/)).toBeVisible();
  await input.press('Escape');
  await expect(page.getByText(/Nothing matches "ZZ-NOT-AN-ITEM-UI-REVIEW"/)).toHaveCount(0);
  // A cut sold by weight: it goes on the bill waiting for its weight.
  const cut=meat.items[0].name;
  await input.fill(cut);
  const match=page.locator('.rt-matches button').filter({hasText:cut});
  await expect(match).toBeVisible();
  await match.click();
  await expect(page.getByRole('button',{name:'Clear',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/^Hold/})).toBeVisible();
  await expect(page.locator('.rt-post')).toBeDisabled();
  await page.getByRole('button',{name:'Clear',exact:true}).click();
  await expect(page.getByText(/Nothing on the bill yet/)).toBeVisible();
});

for(const type of ['grocery','supermarket','wholesale','fashion','electronics','pharmacy','books','salon','healthcare','meat','weight_retail','general_retail','hardware','agri_inputs','optical','garage','jewellery','fuel_station','memberships','laundry','rentals','lodging'])test(`enabled related pages for ${type} show their selection and successful API reads`,async({page})=>{
  test.setTimeout(180000);
  await page.setViewportSize({width:1440,height:900});
  const failures=[];
  page.on('pageerror',error=>failures.push(error.message));
  page.on('response',response=>{
    if(response.status()>=400&&response.url().includes('/api/businesses/'))failures.push(`${response.status()} ${response.url()}`);
  });
  let reviewed=0;
  const business=businessOf(type);
  const sections=await page.evaluate(async({id,type})=>{
    const api=await import('/src/services/business.service.js');
    const nav=await import('/src/services/businessNav.js');
    const workspace=await import('/src/services/businessWorkspace.js');
    const context=await api.businessContext(id);
    const allowed=rule=>rule&&nav.typeAllows(rule,type)&&(!rule.need||context.permissions.includes(rule.need)&&context.modules.includes(rule.need.split('.')[0]))&&(!rule.module||context.modules.includes(rule.module));
    const rules=nav.businessSections(type).flatMap(group=>group.links);
    const names=workspace.dailyWorkspaces(type).flatMap(group=>group.keys).flatMap(key=>workspace.WORKSPACES[key]?workspace.workspaceSections(key,type):[key]);
    return [...new Set(names)].filter(name=>!['','counter','rx-sale','salon-bill','jewellery-bill','dispatch','routes'].includes(name)&&allowed(rules.find(rule=>rule.section===name&&nav.typeAllows(rule,type))));
  },{id:business.id,type});
  for(const section of sections){
    const url=`/business-admin/${business.id}/${section}`;
    await page.goto(url);
    await expect(page.locator('main.content-scroll h1').first(),url).toBeVisible({timeout:30000});
    await expect(page.getByRole('heading',{name:'Not available here',exact:true}),url).toHaveCount(0);
    const related=page.getByRole('navigation',{name:'Related pages'});
    if(await related.count()){
      await expect(related.locator('[aria-current="page"]'),url).toHaveCount(1);
      await expect(related.locator('[aria-current="page"]'),url).toHaveAttribute('href',url);
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),url).toBeTruthy();
    reviewed++;
  }
  console.log(`Reviewed ${reviewed} enabled business pages and their related tabs.`);
  expect(failures).toEqual([]);
});

test('restaurant related areas open and internal view tabs respond',async({page})=>{
  test.setTimeout(300000);
  const failures=[];
  page.on('pageerror',error=>failures.push(error.message));
  page.on('response',response=>{
    if(response.status()>=500&&response.url().includes('/api/'))failures.push(`${response.status()} ${response.url()}`);
  });
  const routes=['/logbook','/activity-log','/menu/products','/menu/categories','/menu/modifiers','/menu/tax-rates','/menu/happy-hour','/inventory/items','/inventory/stock','/inventory/insights','/inventory/transfers','/inventory/settings','/purchasing/orders','/purchasing/suppliers','/purchasing/accounts','/crm/customers','/crm/feedback','/crm/complaints','/crm/insights','/staff','/staff/shifts','/staff/attendance','/staff/timeclock','/staff/payroll','/staff/tips','/restaurant/settings','/restaurant/profile','/restaurant/hours','/restaurant/features','/restaurant/outlets','/service/settings','/discounts','/users','/roles'];
  for(const url of routes){
    await page.goto(url);
    await expect(page.locator('main.content-scroll h1').first(),url).toBeVisible({timeout:30000});
    const related=page.getByRole('navigation',{name:'Related pages'});
    await expect(related.locator('[aria-current="page"]'),url).toHaveAttribute('href',url);
    const viewTabs=page.locator('[role="tablist"] [role="tab"]');
    for(let index=0;index<await viewTabs.count();index++){
      const tab=viewTabs.nth(index);
      if(!await tab.isVisible()||!await tab.isEnabled({timeout:2000}).catch(()=>false))continue;
      try{await tab.click({timeout:5000});}
      catch(error){if(!await tab.count())continue;throw error;}
      if(await tab.count())await expect(tab).toHaveAttribute('aria-selected','true');
    }
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),url).toBeTruthy();
  }
  expect(failures).toEqual([]);
});
