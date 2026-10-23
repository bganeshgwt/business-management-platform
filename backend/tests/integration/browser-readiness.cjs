// Opt-in browser acceptance against this suite's disposable database. Every
// /api request is forwarded to the isolated server, never the working API.
const { chromium, expect } = require('../../../node_modules/@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

module.exports = async (t, { base, token, one, rid, category, unit, request }) => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const directory = path.resolve(__dirname, '../../.local/readiness-ui');
  fs.mkdirSync(directory, { recursive: true });
  try {
    for (const width of [1440, 390]) {
      await t.test(`serving options, combo picker, production and batch wastage work at ${width}px`, { timeout: 120000 }, async () => {
        const name = `UI meal ${width}`;
        const meal = await one('INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,$3,100,0) RETURNING id', [rid, category.id, name]);
        const drink = await one('INSERT INTO products(restaurant_id,category_id,name,price,tax_percentage) VALUES($1,$2,$3,20,0) RETURNING id', [rid, category.id, `UI drink ${width}`]);
        const raw = await one('INSERT INTO inventory_items(restaurant_id,name,unit_id) VALUES($1,$2,$3) RETURNING id', [rid, `UI raw ${width}`, unit.id]);
        const output = await one("INSERT INTO inventory_items(restaurant_id,name,unit_id,item_type) VALUES($1,$2,$3,'prepared') RETURNING id", [rid, `UI gravy ${width}`, unit.id]);
        await request('POST', '/inventory/movements/in', { inventoryItemId: raw.id, quantity: 10, unitCost: 30, batchNumber: `UI-RAW-${width}`, expiryDate: '2099-01-01' }, 201);
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: width === 390 ? 'dark' : 'light' });
        const failures = [];
        let closing = false;
        await context.addInitScript(value => localStorage.setItem('rmp_token', value), token);
        await context.route(/\/api(?:\/|$)/, async route => {
          const incoming = new URL(route.request().url());
          const url = base + incoming.pathname.slice(incoming.pathname.indexOf('/api') + 4) + incoming.search;
          try { await route.fulfill({ response: await route.fetch({ url }) }); }
          catch {
            // Browser shutdown may interrupt the final refresh. Do not log
            // Playwright's request dump, which includes the disposable token.
            if (!closing) failures.push(`Isolated API forwarding failed: ${incoming.pathname}`);
            await route.abort().catch(() => {});
          }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(10000);
        page.setDefaultNavigationTimeout(15000);
        page.on('pageerror', error => failures.push(error.message));
        page.on('response', response => { if (response.status() >= 500) failures.push(`${response.status()} ${response.url()}`); });
        const goto = async route => {
          await page.goto((process.env.E2E_BASE_URL || 'http://localhost:5173') + route);
          await expect(page.locator('main.content-scroll')).toBeVisible();
          await page.waitForLoadState('networkidle');
        };
        try {
          await goto('/menu/products');
          await page.getByRole('button', { name: `More actions for ${name}`, exact: true }).click();
          await page.getByRole('menuitem', { name: 'Serving times & combo choices' }).click();
          await page.getByRole('button', { name: 'Add serving period', exact: true }).click();
          await page.getByLabel('From', { exact: true }).fill('07:00');
          await page.getByLabel('Until', { exact: true }).fill('11:00');
          await page.getByRole('button', { name: 'Add combo group', exact: true }).click();
          await page.getByLabel('Group name').fill('Choose a drink');
          await page.getByRole('button', { name: 'Add choice', exact: true }).click();
          await page.locator('.service-option-row select').first().selectOption(String(drink.id));
          await page.getByLabel('Extra price').fill('10');
          await page.screenshot({ path: path.join(directory, `serving-options-${width}.png`), fullPage: true });
          // Exercise scheduled controls, then leave this dish all-day for POS.
          await page.getByRole('button', { name: 'Remove period', exact: true }).click();
          await page.getByRole('button', { name: 'Save serving options' }).click();
          await expect(page.getByText('Serving times and combo choices saved')).toBeVisible();
          const config = await request('GET', `/menu/products/${meal.id}/service-options`);
          assert.equal(config.groups[0].options[0].productId, drink.id);
          await page.locator('.modal-close').click();

          await goto('/pos');
          await page.getByRole('radio', { name: 'Takeaway', exact: true }).click();
          await page.getByPlaceholder(/^Dish name or code/).fill(name);
          await page.getByText(name, { exact: true }).first().click();
          await expect(page.getByRole('button', { name: 'Add to order', exact: true })).toBeDisabled();
          await page.getByRole('radio', { name: new RegExp(`UI drink ${width}`) }).check();
          await expect(page.getByRole('button', { name: 'Add to order', exact: true })).toBeEnabled();
          await page.screenshot({ path: path.join(directory, `combo-picker-${width}.png`), fullPage: true });
          await page.getByRole('button', { name: 'Add to order', exact: true }).click();

          await goto('/inventory/items?tab=production');
          await page.getByLabel('Prepared item').selectOption(String(output.id));
          await page.getByRole('button', { name: 'Add ingredient', exact: true }).click();
          await page.locator('.service-option-row select').first().selectOption(String(raw.id));
          await page.getByLabel('Quantity per unit').fill('0.5');
          await expect(page.getByRole('button', { name: 'Post production', exact: true })).toBeDisabled();
          await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
          await expect(page.getByText('Prepared-item recipe saved')).toBeVisible();
          await page.getByLabel('Actual output').fill('2');
          await page.getByLabel('Batch number', { exact: true }).fill(`UI-PREP-${width}`);
          await page.getByLabel('Expiry date', { exact: true }).fill('2099-01-01');
          await page.getByRole('button', { name: 'Post production', exact: true }).click();
          await expect(page.getByText('Production posted. Ingredient stock and prepared stock are updated.')).toBeVisible();
          assert.equal(Number((await one('SELECT current_stock FROM inventory_items WHERE id=$1', [output.id])).current_stock), 2);
          await page.screenshot({ path: path.join(directory, `production-${width}.png`), fullPage: true });
          const row = page.getByRole('row').filter({ hasText: `UI-PREP-${width}` });
          await row.getByRole('button', { name: 'Void batch' }).click();
          await page.getByLabel('Reason', { exact: true }).fill('UI reversal check');
          await page.getByRole('button', { name: 'Confirm void' }).click();
          await expect(row).toContainText('Voided');
          assert.equal(Number((await one('SELECT current_stock FROM inventory_items WHERE id=$1', [raw.id])).current_stock), 10);

          await goto('/inventory/items?tab=batches');
          await page.getByLabel('Find item or batch').fill(`UI-RAW-${width}`);
          await page.getByRole('button', { name: 'Record wastage', exact: true }).click();
          await page.getByLabel('Quantity (kg)', { exact: true }).fill('1');
          await page.getByLabel('Reason', { exact: true }).fill('Spillage');
          await page.screenshot({ path: path.join(directory, `batch-wastage-${width}.png`), fullPage: true });
          await page.getByRole('dialog').getByRole('button', { name: 'Record wastage', exact: true }).click();
          await expect(page.getByText('Wastage recorded against the selected batch')).toBeVisible();
          assert.equal(Number((await one('SELECT current_stock FROM inventory_items WHERE id=$1', [raw.id])).current_stock), 9);
          assert.deepEqual(failures, []);
        } catch (error) {
          await page.screenshot({ path: path.join(directory, `failure-${width}.png`), fullPage: true });
          throw error;
        } finally {
          closing = true;
          await page.close();
          await context.unrouteAll({ behavior: 'wait' });
          await context.close();
        }
      });
    }
  } finally { await browser.close(); }
};
