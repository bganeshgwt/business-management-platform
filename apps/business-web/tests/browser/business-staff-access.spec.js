import {test,expect} from '@playwright/test';

import {business,signIn} from '../../../../e2e/fixture.mjs';

// Staff & access: which department a person works in, on both "New staff
// login" and "Give access", and which people offer Change and Password. The
// test supermarket (e2e/test-data.mjs), which the restaurant's admin owns,
// keeps no departments and no other staff, so those are answered here; the
// dialogs are closed without saving anything.
const DIALOGS=[['New staff login','New staff login'],['Give access','Give someone access']];

test.beforeEach(async({page})=>{
  await signIn(page);
  await expect(page.locator('main.content-scroll')).toBeVisible({timeout:30000});
});

test('both staff dialogs offer the active departments, and show no department field without any',async({page})=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const shop=business('supermarket');
  // The shop's real answer, with this list of departments in it.
  let departments=[{id:901,name:'Clothing',active:true},{id:902,name:'Footwear',active:true},{id:903,name:'Old counter',active:false}];
  const DEPARTMENTS_URL=/\/api\/businesses\/\d+\/departments$/;
  await page.route(DEPARTMENTS_URL,async route=>{
    const response=await route.fetch();
    await route.fulfill({response,json:{success:true,data:departments}});
  });
  // Each dialog asks for the departments when it opens: wait for the answer.
  const open=async(button,title)=>{
    const answered=page.waitForResponse(response=>response.request().method()==='GET'&&DEPARTMENTS_URL.test(new URL(response.url()).pathname));
    await page.getByRole('button',{name:button,exact:true}).click();
    const dialog=page.getByRole('dialog',{name:title});
    await expect(dialog).toBeVisible();
    await answered;
    // Let the answer reach the screen, so a field that is not there has had its chance to appear.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    return dialog;
  };
  const close=async dialog=>{
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    await expect(dialog).toHaveCount(0);
  };

  await page.goto(`/business-admin/${shop.id}/staff`);
  await expect(page.getByRole('heading',{name:'Staff & access',exact:true})).toBeVisible({timeout:30000});
  for(const [button,title] of DIALOGS){
    const dialog=await open(button,title);
    const field=dialog.getByRole('combobox',{name:'Department'});
    // A department switched off is not offered to someone new.
    await expect(field.locator('option')).toHaveText(['All departments','Clothing','Footwear']);
    await expect(field).toHaveValue('');
    await expect(field).toBeEnabled();
    await close(dialog);
  }

  departments=[];
  await page.reload();
  await expect(page.getByRole('heading',{name:'Staff & access',exact:true})).toBeVisible({timeout:30000});
  for(const [button,title] of DIALOGS){
    const dialog=await open(button,title);
    await expect(dialog.getByRole('combobox',{name:'Role',exact:true})).toBeVisible();
    await expect(dialog.getByRole('combobox',{name:'Department'})).toHaveCount(0);
    await close(dialog);
  }
  expect(errors).toEqual([]);
});

test('Change and Password show only for the people the staff list says you manage',async({page})=>{
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const shop=business('supermarket');
  // The shop's real staff list, with two more people in it: one the caller
  // manages and one they do not (as a department head sees someone of another
  // department, or someone whose role can do more than theirs).
  const person=(id,name,manages)=>({id,name,email:`${name.split(' ')[0].toLowerCase()}@staff.e2e.invalid`,role_id:null,role_name:'Cashier / sales',full_access:false,
    active:true,last_opened_at:null,created_at:new Date().toISOString(),location_id:null,location_name:null,department_id:null,department_name:null,manages});
  await page.route(/\/api\/businesses\/\d+\/members(?:\?|$)/,async route=>{
    const response=await route.fetch();
    const {data}=await response.json();
    const items=[...data.items,person(990001,'Farah Khan',true),person(990002,'Gopal Das',false)];
    await route.fulfill({response,json:{success:true,data:{total:items.length,items}}});
  });

  await page.goto(`/business-admin/${shop.id}/staff`);
  const people=page.getByRole('table',{name:'People with access'});
  const actions=name=>people.getByRole('row').filter({hasText:name}).getByRole('button',{name:/^(Change|Password)$/});
  await expect(actions('Farah Khan')).toHaveText(['Change','Password'],{timeout:30000});
  await expect(actions('Gopal Das')).toHaveCount(0);
  // Nor on the caller's own row (the owner's).
  await expect(people.getByRole('row').filter({hasText:'(you)'})).toHaveCount(1);
  await expect(actions('(you)')).toHaveCount(0);
  expect(errors).toEqual([]);
});
