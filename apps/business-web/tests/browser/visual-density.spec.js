import {test,expect} from '@playwright/test';

import {business,signIn} from '../../../../e2e/fixture.mjs';

// The screenshots for the visual review go to each test's own folder under
// test-results, which every run starts afresh.
test.beforeEach(async({page})=>{
  await signIn(page,'RESTAURANT_ADMIN');
  await expect(page.locator('main.content-scroll')).toBeVisible();
});

for(const width of [1440,390])test(`guest groups remain accessible with compact shortcuts at ${width}px`,async({page},testInfo)=>{
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width,height:900});
  await page.goto('/crm/insights?segment=unhappy');
  await expect(page.getByRole('heading',{name:'Guest insights',exact:true})).toBeVisible({timeout:30000});
  const shortcuts=page.getByRole('group',{name:'Guest lists',exact:true});
  await expect(shortcuts.getByRole('button')).toHaveCount(4);
  await expect(page.locator('.gi-kpis .stat-tile')).toHaveCount(4);
  const select=page.getByRole('combobox',{name:'Guest group',exact:true});
  await expect(select).toHaveValue('unhappy');
  const groups=await select.locator('option').evaluateAll(options=>options.map(option=>({key:option.value,label:option.textContent.replace(/\s+\([\d,]+\)$/,'')})));
  expect(groups).toHaveLength(8);
  for(const group of groups){
    const read=page.waitForResponse(response=>response.url().includes(`/guest-insights/segments/${group.key}`)&&response.request().method()==='GET');
    await select.selectOption(group.key);
    const response=await read;
    expect(response.status(),group.key).toBe(200);
    const result=(await response.json()).data;
    expect(result.segment.key).toBe(group.key);
    await expect(page.getByRole('region',{name:'Selected guest list'}).getByRole('heading').first()).toContainText(group.label);
  }
  await select.selectOption('unhappy');
  await shortcuts.getByRole('button',{name:/Regulars/}).click();
  await expect(select).toHaveValue('regulars');
  await expect(shortcuts.locator('[aria-pressed="true"]')).toHaveCount(1);
  const search=page.getByRole('searchbox',{name:'Search this list',exact:true});
  const searchRead=page.waitForResponse(response=>response.url().includes('/guest-insights/segments/regulars')&&response.url().includes('search=ZZ-NOBODY-VISUAL-REVIEW'));
  await search.fill('ZZ-NOBODY-VISUAL-REVIEW');
  expect((await (await searchRead).json()).data.total).toBe(0);
  await select.selectOption('birthdays');
  await expect(search).toHaveValue('');
  await expect(shortcuts.locator('[aria-pressed="true"]')).toHaveCount(0);
  const finalRead=page.waitForResponse(response=>response.url().includes('/guest-insights/segments/unhappy')&&response.request().method()==='GET');
  await select.selectOption('unhappy');
  await finalRead;
  await expect(page.locator('.gi-panel [aria-busy="true"]')).toHaveCount(0);
  const analytics=page.locator('.gi-analytics');
  await expect(analytics).not.toHaveAttribute('open');
  await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
  await page.screenshot({path:testInfo.outputPath(`guest-insights-${width}.png`)});
  if(width===1440)await page.locator('.gi-lists').screenshot({path:testInfo.outputPath(`guest-lists-${width}.png`)});
  await analytics.locator('summary').click();
  await expect(analytics).toHaveAttribute('open');
  await expect(analytics.locator('.gi-charts')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('capture other dense work areas for a visual review',async({page},testInfo)=>{
  test.setTimeout(240000);
  await page.setViewportSize({width:1440,height:1000});
  // The test data's meat shop, wholesaler (a retailer owes it) and salon (a stylist to book).
  const meat=business('meat');
  const wholesale=business('wholesale');
  const salon=business('salon');
  const routes=[['activity-log','/activity-log'],['waste','/inventory/insights'],['reorder','/inventory/insights?tab=reorder'],['theft','/reports?tab=theft'],['time-clock','/staff/timeclock'],['business-day','/business-day'],['shop-overview',`/business-admin/${meat.id}`],['wholesale-dues',`/business-admin/${wholesale.id}/outstanding`],['salon-calendar',`/business-admin/${salon.id}/salon-calendar`]];
  for(const [name,url]of routes){
    await page.goto(url);
    await expect(page.locator('main.content-scroll h1').first(),url).toBeVisible({timeout:30000});
    await page.waitForLoadState('networkidle');
    await expect(page.locator('main.content-scroll [aria-busy="true"]')).toHaveCount(0,{timeout:30000});
    await page.evaluate(()=>Promise.all(document.getAnimations().filter(animation=>animation.effect?.getComputedTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))));
    await page.screenshot({path:testInfo.outputPath(`${name}.png`)});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),url).toBeTruthy();
  }
});

test('stock and billing selectors keep their matching details',async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:1000});
  const planRead=page.waitForResponse(response=>response.url().includes('/inventory-insights/reorder')&&response.request().method()==='GET');
  await page.goto('/inventory/insights?tab=reorder');
  const plan=(await (await planRead).json()).data;
  // The test data keeps an item under its reorder level, so Low has rows to show.
  expect(plan.summary.low).toBeGreaterThan(0);
  const low=page.locator('.ii-tiles').getByRole('button',{name:/^Low /});
  await expect(low).toBeVisible({timeout:30000});
  await low.click();
  await expect(low).toHaveAttribute('aria-pressed','true');
  const status=page.getByRole('radiogroup',{name:'Status',exact:true});
  await expect(status.getByRole('radio',{name:'Low',exact:true})).toHaveAttribute('aria-checked','true');
  await expect(page).toHaveURL(/status=low/);
  await expect(page.locator('.ii-all .filters-summary')).toHaveText(`${plan.summary.low} item${plan.summary.low===1?'':'s'}`);
  for(const badge of await page.locator('.ii-all .ii-status').all())await expect(badge).toHaveText('Low');
  await low.click();
  await expect(low).toHaveAttribute('aria-pressed','false');
  await expect(status.getByRole('radio',{name:'All',exact:true})).toHaveAttribute('aria-checked','true');
  const out=page.locator('.ii-tiles').getByRole('button',{name:/^Out of stock/});
  await out.click();
  await expect(status.getByRole('radio',{name:'Out',exact:true})).toHaveAttribute('aria-checked','true');
  await expect(out).toHaveAttribute('aria-pressed','true');
  await page.screenshot({path:testInfo.outputPath('reorder-selected.png')});
  await page.reload();
  await expect(out).toHaveAttribute('aria-pressed','true',{timeout:30000});
  const show=page.getByRole('radiogroup',{name:'What to show',exact:true});
  await show.getByRole('radio',{name:/^To order/}).click();
  await expect(show.getByRole('radio',{name:/^To order/})).toHaveAttribute('aria-checked','true');
  expect(new URL(page.url()).searchParams.has('view')).toBeFalsy();
  expect(new URL(page.url()).searchParams.has('status')).toBeFalsy();
  await expect(page.getByRole('radiogroup',{name:'Status',exact:true})).toHaveCount(0);

  await page.goto('/reports?tab=theft');
  const refunds=page.locator('.theft-tiles').getByRole('button',{name:/^Refunds/});
  await expect(refunds).toBeVisible({timeout:30000});
  await refunds.click();
  const details=page.getByRole('tablist',{name:'Details',exact:true});
  await expect(details.getByRole('tab',{name:'Refunds',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('heading',{name:'Refunds',exact:true})).toBeVisible();
  await details.getByRole('tab',{name:'Voids',exact:true}).click();
  await expect(page.locator('.theft-tiles .is-selected')).toContainText('Bills voided');

  await page.goto('/staff/timeclock');
  await expect(page.locator('.tc-stat-grid .stat-tile')).toHaveCount(5,{timeout:30000});
  const views=page.getByRole('tablist',{name:'Time clock views',exact:true});
  await views.getByRole('tab',{name:'Day timeline',exact:true}).click();
  await expect(views.getByRole('tab',{name:'Day timeline',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.tc-stat-grid .stat-tile').first()).toBeVisible();
  await views.getByRole('tab',{name:'Clock in / out',exact:true}).click();
  await expect(views.getByRole('tab',{name:'Clock in / out',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.locator('.tc-stat-grid .stat-tile')).toHaveCount(5);
});
