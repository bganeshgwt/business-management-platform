import {test,expect} from '@playwright/test';

import {business,signIn} from '../../../../e2e/fixture.mjs';

// Staff & access: which department a person works in, on both "New staff
// login" and "Give access". The test supermarket (e2e/test-data.mjs), which
// the restaurant's admin owns, keeps no departments, so the list is answered
// here; the dialogs are closed without saving anything.
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
    await expect(dialog.getByRole('combobox',{name:'Role'})).toBeVisible();
    await expect(dialog.getByRole('combobox',{name:'Department'})).toHaveCount(0);
    await close(dialog);
  }
  expect(errors).toEqual([]);
});
