const { chromium, expect } = require('../../../node_modules/@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// Business Admin in a real browser, against the API suite's throwaway
// database (every /api request is forwarded to it): add a product, receive
// it, sell it, collect, take it back, refund, the unsaved-form guard and the
// header switcher, at 1440 px light and 390 px dark.
module.exports = async (t, { base, token, businesses }) => {
  const browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined });
  const output = path.resolve(__dirname, '../../.local/business-admin-ui');
  fs.mkdirSync(output, { recursive: true });
  const web = process.env.E2E_BASE_URL || 'http://127.0.0.1:5175';
  try {
    for (const width of [1440, 390]) {
      await t.test(`Business Admin at ${width}px: catalogue, receipt, sale, return, refund and switching`, { timeout: 180000 }, async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: width === 390 ? 'dark' : 'light' });
        let closing = false;
        const errors = [];
        await context.addInitScript((value) => localStorage.setItem('rmp_token', value), token);
        await context.route(/\/api(?:\/|$)/, async (route) => {
          const incoming = new URL(route.request().url());
          try { await route.fulfill({ response: await route.fetch({ url: base + incoming.pathname.slice(incoming.pathname.indexOf('/api') + 4) + incoming.search }) }); }
          catch { if (!closing) errors.push('API forwarding failed'); await route.abort().catch(() => {}); }
        });
        const page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', (error) => errors.push(error.message));
        const books = businesses.find((b) => b.business_type === 'books');
        const go = async (section, heading) => {
          await page.goto(`${web}/business-admin/${books.id}${section ? `/${section}` : ''}`);
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
        };
        const dialog = page.getByRole('dialog');
        const button = (name) => page.getByRole('button', { name, exact: true });
        try {
          await go('', 'Overview');
          await go('products', 'Books & stationery');
          await button('Add item').click();
          await dialog.getByLabel('Product name', { exact: true }).fill(`Book ${width}`);
          await dialog.getByLabel('SKU code', { exact: true }).fill(`BOOK-${width}`);
          await dialog.getByLabel('Selling price (before GST)', { exact: true }).fill('120');
          await dialog.getByLabel('GST slab', { exact: true }).selectOption({ label: 'GST nil / exempt' });
          await dialog.getByLabel('ISBN', { exact: true }).fill(`TEST-${width}`);
          await dialog.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(dialog).toHaveCount(0);
          await expect(page.getByText(`Book ${width}`, { exact: true }).first()).toBeVisible();

          await go('suppliers', 'Suppliers');
          await button('Add supplier').click();
          await dialog.getByLabel('Name', { exact: true }).fill(`Supplier ${width}`);
          await dialog.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(dialog).toHaveCount(0);

          await go('purchases', 'Purchases');
          await button('Receive purchase').click();
          await expect(dialog.getByRole('button', { name: 'Post receipt' })).toBeEnabled();
          await dialog.getByLabel('Supplier', { exact: true }).selectOption({ label: `Supplier ${width}` });
          const line = dialog.locator('.bz-lines');
          await line.locator('select').first().selectOption({ label: `Book ${width} · BOOK-${width}` });
          await line.locator('input[type="number"]').nth(0).fill('5');
          await line.locator('input[type="number"]').nth(1).fill('60');
          await dialog.getByRole('button', { name: 'Post receipt' }).click();
          // The posted receipt opens on its own, owing the supplier.
          await expect(page.getByRole('dialog').getByRole('button', { name: 'Record payment' })).toBeVisible();
          await page.keyboard.press('Escape');
          await expect(dialog).toHaveCount(0);

          await go('stock', 'Stock on hand');
          await expect(page.getByText(`Book ${width}`, { exact: true }).first()).toBeVisible();
          await page.screenshot({ path: path.join(output, `stock-${width}.png`), fullPage: true });

          await go('sales', 'Sales');
          await button('New sale').click();
          await expect(dialog.getByRole('button', { name: 'Post sale' })).toBeEnabled();
          await dialog.locator('.bz-lines select').first().selectOption({ label: `Book ${width} · BOOK-${width}` });
          await dialog.getByRole('button', { name: 'Post sale' }).click();
          // The new sale opens on its own once posted.
          const detail = page.getByRole('dialog').last();
          await expect(detail.getByRole('button', { name: 'Record collection' })).toBeVisible();
          await detail.getByRole('button', { name: 'Record collection' }).click();
          const action = page.getByRole('dialog').last();
          await action.getByLabel('Amount', { exact: true }).fill('120');
          await action.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(detail.getByRole('button', { name: 'Take back items' })).toBeVisible();
          await expect(detail.getByRole('button', { name: 'Record collection' })).toHaveCount(0);
          await detail.getByRole('button', { name: 'Take back items' }).click();
          const back = page.getByRole('dialog').last();
          await back.getByLabel('Quantity', { exact: true }).fill('1');
          await back.getByLabel('Reason', { exact: true }).fill('Browser acceptance return');
          await back.getByRole('button', { name: 'Post return' }).click();
          await expect(detail.getByRole('button', { name: 'Refund customer' })).toBeVisible();
          await detail.getByRole('button', { name: 'Refund customer' }).click();
          const refund = page.getByRole('dialog').last();
          await refund.getByLabel('Reason', { exact: true }).fill('Browser acceptance refund');
          await refund.getByRole('button', { name: 'Save', exact: true }).click();
          await expect(detail.getByRole('button', { name: 'Refund customer' })).toHaveCount(0);
          await expect(page.getByRole('dialog')).toHaveCount(1);
          await detail.getByRole('button', { name: 'Close', exact: true }).click();
          await expect(page.getByRole('dialog')).toHaveCount(0);

          // An unsaved form asks before it is thrown away.
          await go('products', 'Books & stationery');
          await button('Add item').click();
          await dialog.getByLabel('Product name', { exact: true }).fill('Unsaved');
          page.once('dialog', (prompt) => prompt.dismiss());
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
          await expect(dialog).toBeVisible();
          page.once('dialog', (prompt) => prompt.accept());
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
          await expect(dialog).toHaveCount(0);

          // The header switcher opens each business with its own menu.
          for (const business of businesses.filter((b) => b.id !== books.id && b.business_type !== 'restaurant').slice(0, 4)) {
            await page.locator('.bsw-trigger').click();
            await page.getByRole('option', { name: new RegExp(business.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).click();
            await expect(page).toHaveURL(new RegExp(`/business-admin/${business.id}$`));
            await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
            await expect(page.locator('.page-header')).toContainText(business.name);
          }
          await page.screenshot({ path: path.join(output, `overview-${width}.png`), fullPage: true });
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'No outer horizontal overflow');
          assert.deepEqual(errors, []);
        } catch (error) {
          await page.screenshot({ path: path.join(output, `failure-${width}.png`), fullPage: true });
          throw error;
        } finally { closing = true; await context.close(); }
      });
    }
  } finally { await browser.close(); }
};
