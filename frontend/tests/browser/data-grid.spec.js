import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// The shared DataGrid (components/DataGrid): sorting, search, filters, paging
// with serial numbers that run on across pages, column hiding and resizing
// remembered over a reload, CSV export, the phone card layout, and the entry
// ("editor") variant — then the two screens converted to it.
//
// The component checks run on a scratch page that exists only inside this
// test: the app's own index.html is opened at /__data-grid-fixture and its
// /src/main.jsx is answered with a small module that mounts DataGrid on 60
// made-up purchase orders and an entry form. No app route is added for it.
//
// The screen checks sign in like screens.spec.js (E2E_CREDENTIALS_FILE). The
// platform console needs a SUPER_ADMIN account in that file; without one that
// part is skipped. GRID_SHOTS_DIR, when set, receives screenshots.

const credentialsFile = process.env.E2E_CREDENTIALS_FILE;
const accounts = credentialsFile ? JSON.parse(fs.readFileSync(credentialsFile, "utf8")).accounts : [];
const admin = accounts.find((a) => a.role === "RESTAURANT_ADMIN");
const platformOwner = accounts.find((a) => a.role === "SUPER_ADMIN");
const shotsDir = process.env.GRID_SHOTS_DIR;

const shot = async (page, name) => {
  if (shotsDir) {
    fs.mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  }
};

// --- The scratch page ------------------------------------------------------------

const SUPPLIERS = ["Fresh Farm Produce", "Annapurna Dairy", "Spice Bazaar", "Coastal Fish Co", "Green Leaf Veg"];
const STATUSES = ["draft", "ordered", "received", "cancelled"];
// The same 60 rows the fixture builds, so expected figures are worked out here.
const ORDERS = Array.from({ length: 60 }, (_, i) => ({
  number: `PO-${1001 + i}`,
  supplier: SUPPLIERS[i % 5],
  status: STATUSES[i % 4],
  date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
  total: ((i * 37) % 500) * 10 + (i % 2 ? 0.5 : 0),
}));

const fixtureModule = (reactUrl, clientUrl) => `
const React = (await import(${JSON.stringify(reactUrl)})).default;
const { createRoot } = (await import(${JSON.stringify(clientUrl)})).default;
await import("/src/index.css");
await import("/src/styles/ui.css");
await import("/src/styles/motion.css");
await import("/src/styles/colour.css");
const { default: DataGrid } = await import("/src/components/DataGrid/DataGrid.jsx");
const h = React.createElement;
const SUPPLIERS = ${JSON.stringify(SUPPLIERS)};
const STATUSES = ${JSON.stringify(STATUSES)};
const rows = Array.from({ length: 60 }, (_, i) => ({
  id: i + 1,
  number: "PO-" + (1001 + i),
  supplier: SUPPLIERS[i % 5],
  status: STATUSES[i % 4],
  date: "2026-09-" + String((i % 28) + 1).padStart(2, "0"),
  total: ((i * 37) % 500) * 10 + (i % 2 ? 0.5 : 0),
}));
const columns = [
  { key: "number", header: "PO no.", value: (r) => r.number, mobile: "title", pin: true },
  { key: "supplier", header: "Supplier", value: (r) => r.supplier, filter: "text" },
  { key: "status", header: "Status", type: "status", value: (r) => r.status, filter: "select", mobile: "subtitle" },
  { key: "date", header: "Date", type: "date", value: (r) => r.date },
  { key: "total", header: "Total", type: "money", exact: true, value: (r) => r.total, total: "sum" },
  { key: "actions", header: "", type: "actions", render: (r) => h("button", { type: "button", className: "chip-button", onClick: () => { window.__opened = r.number; } }, "Open") },
];
function Lines() {
  const [lines, setLines] = React.useState([
    { id: 1, item: "Basmati rice", qty: 10, rate: 92 },
    { id: 2, item: "Toor dal", qty: 5, rate: 128 },
    { id: 3, item: "Ghee", qty: 2, rate: 610 },
  ]);
  const set = (id, field, value) => setLines((all) => all.map((l) => (l.id === id ? { ...l, [field]: value } : l)));
  const input = (l, ctx, field, type) => h("input", { type, "aria-label": ctx.label, value: l[field], onChange: (e) => set(l.id, field, type === "number" ? Number(e.target.value) : e.target.value) });
  return h("form", { id: "fx-form", onSubmit: (e) => { e.preventDefault(); window.__submitted = (window.__submitted || 0) + 1; } },
    h(DataGrid, { variant: "editor", caption: "Purchase lines", rows: lines, columns: [
      { key: "item", header: "Item", value: (l) => l.item, render: (l, ctx) => input(l, ctx, "item", "text") },
      { key: "qty", header: "Qty", type: "number", value: (l) => l.qty, total: "sum", render: (l, ctx) => input(l, ctx, "qty", "number") },
      { key: "rate", header: "Rate", type: "money", value: (l) => l.rate, render: (l, ctx) => input(l, ctx, "rate", "number") },
      { key: "amount", header: "Amount", type: "money", exact: true, value: (l) => l.qty * l.rate, total: "sum" },
    ] }),
    h("button", { type: "submit", className: "button" }, "Save lines"));
}
// A list the "API" pages: priced in AED, with one refund (negative), totals
// from the "server", and rows per page held by the page as a real one does.
const serverRows = rows.map((r) => ({ ...r, total: r.id === 2 ? -r.total : r.total }));
function ServerList() {
  const [state, setState] = React.useState({ page: 1, pageSize: 25 });
  const start = (state.page - 1) * state.pageSize;
  return h(DataGrid, {
    id: "fx-server", caption: "Server orders", currency: "AED ", rowNoun: ["order", "orders"], exportName: "fx-server",
    rows: serverRows.slice(start, start + state.pageSize),
    columns: [
      { key: "number", header: "PO no.", value: (r) => r.number, mobile: "title" },
      { key: "supplier", header: "Supplier", value: (r) => r.supplier },
      { key: "total", header: "Total", type: "money", exact: true, value: (r) => r.total, total: "sum" },
    ],
    server: {
      total: serverRows.length, page: state.page, pageSize: state.pageSize,
      totals: { total: serverRows.reduce((sum, r) => sum + Math.round(r.total * 100), 0) / 100 },
      onChange: (next) => { (window.__serverCalls = window.__serverCalls || []).push(next); setState({ page: next.page, pageSize: next.pageSize }); },
    },
  });
}
// A small compact table in a dialog-sized box, with a narrow first column
// and narrow sized columns; and one place that shows two lists by id.
function Small() {
  const dishes = [
    { id: 1, n: 1, name: "Paneer tikka", qty: 14, note: "Hot" },
    { id: 2, n: 2, name: "Dal makhani", qty: 9, note: "" },
    { id: 3, n: 3, name: "Butter naan", qty: 31, note: "Extra butter" },
  ];
  return h("div", { id: "fx-small", style: { width: 460, maxWidth: "100%" } }, h(DataGrid, {
    id: "fx-small", caption: "Dishes", variant: "compact", rows: dishes,
    columns: [
      { key: "n", header: "#", type: "number", value: (r) => r.n, width: 48 },
      { key: "name", header: "Dish name", value: (r) => r.name, mobile: "title" },
      { key: "qty", header: "Quantity sold today", type: "number", value: (r) => r.qty, width: 70 },
      { key: "note", header: "Kitchen note", value: (r) => r.note, width: 60 },
    ],
  }));
}
function Swap() {
  const [which, setWhich] = React.useState("a");
  const lists = {
    a: [{ id: 1, name: "Onions" }, { id: 2, name: "Tomatoes" }, { id: 3, name: "Ginger" }],
    b: [{ id: 1, label: "Fresh Farm" }, { id: 2, label: "Spice Bazaar" }],
  };
  return h("div", { id: "fx-swap" },
    h("button", { type: "button", onClick: () => setWhich(which === "a" ? "b" : "a") }, "Swap list"),
    h(DataGrid, which === "a"
      ? { id: "fx-swap-a", caption: "Items", rows: lists.a, columns: [{ key: "name", header: "Item", value: (r) => r.name }] }
      : { id: "fx-swap-b", caption: "Suppliers", rows: lists.b, columns: [{ key: "label", header: "Supplier", value: (r) => r.label }] }));
}
function Fixture() {
  return h("main", { style: { padding: 16, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 24, maxWidth: 1200, margin: "0 auto" } },
    h("section", { id: "fx-list" }, h("h2", null, "Purchase orders"),
      h(DataGrid, { id: "fx-orders", caption: "Purchase orders", columns, rows, exportName: "fx-orders", selectable: true,
        rowClassName: (r) => (r.status === "cancelled" ? "dg-tone-danger" : r.status === "received" ? "dg-tone-success" : ""),
        bulkActions: (picked) => h("span", { className: "fx-bulk" }, picked.length + " ready") })),
    h("section", { id: "fx-editor" }, h("h2", null, "Entry lines"), h(Lines)),
    h("section", { id: "fx-server" }, h("h2", null, "Server orders"), h(ServerList)),
    h("section", null, h("h2", null, "Small and swapped"), h(Small), h(Swap)));
}
createRoot(document.getElementById("root")).render(h(Fixture));
`;

const openFixture = async (page) => {
  await page.route(/\/src\/main\.jsx(\?.*)?$/, async (route) => {
    const original = await route.fetch();
    const text = await original.text();
    const pick = (name) => text.match(new RegExp(`"(/node_modules/\\.vite/deps/${name}\\.js[^"]*)"`))[1];
    await route.fulfill({ response: original, body: fixtureModule(pick("react"), pick("react-dom_client")) });
  });
  await page.goto("/__data-grid-fixture");
  await expect(page.locator("#fx-list :is(.dg-row, .dg-card)").first()).toBeVisible();
};

// Exported CSVs start with a byte-order mark (so Excel reads the rupee sign).
const readCsv = (file) => {
  const text = fs.readFileSync(file, "utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
};

const list = (page) => page.locator("#fx-list");
// Real rows only: the shimmering placeholders while a list loads are rows too.
const ROW = "tbody > tr.dg-row:not(.dg-row-skeleton)";
const rowsOf = (scope) => scope.locator(ROW);
const serials = (scope) => scope.locator(`${ROW} > td.dg-serial-col`).allInnerTexts();
const columnText = async (scope, key) => scope.locator(`${ROW} > td[data-col="${key}"]`).allInnerTexts();
const rupees = (text) => Number(String(text).replace(/[^\d.-]/g, ""));
const exact = (value) => `₹${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;

test.describe("DataGrid component", () => {
  test("sort, search, filter, paging and serial numbers", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page);
    const grid = list(page);

    // S.No. heads the table; page 1 is 1–25 of 60.
    await expect(grid.locator("thead th").first()).toHaveText("S.No.");
    await expect(rowsOf(grid)).toHaveCount(25);
    expect(await serials(grid)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
    await expect(grid.locator(".dg-pager-range")).toHaveText("1–25 of 60");
    await expect(grid.locator(".dg-total-label")).toHaveText("Total · 60 rows");
    const allTotal = ORDERS.reduce((sum, order) => sum + order.total, 0);
    await expect(grid.locator(".dg-total-row td.type-money")).toHaveText(exact(allTotal));
    await shot(page, "fixture-1440-page1");

    // Paging: page 2 starts at 26, the last page ends at 60; totals stay over all 60.
    await grid.getByRole("button", { name: "Next page" }).click();
    await expect(grid.locator(".dg-pager-range")).toHaveText("26–50 of 60");
    expect((await serials(grid))[0]).toBe("26");
    expect(await columnText(grid, "number")).toContain("PO-1026");
    await grid.getByRole("button", { name: "Last page" }).click();
    await expect(grid.locator(".dg-pager-range")).toHaveText("51–60 of 60");
    expect(await serials(grid)).toEqual(Array.from({ length: 10 }, (_, i) => String(51 + i)));
    await expect(grid.locator(".dg-total-row td.type-money")).toHaveText(exact(allTotal));
    await grid.getByRole("button", { name: "Previous page" }).click();
    await expect(grid.locator(".dg-pager-range")).toHaveText("26–50 of 60");
    await grid.getByRole("button", { name: "First page" }).click();
    await expect(grid.locator(".dg-pager-range")).toHaveText("1–25 of 60");
    // The page picker jumps straight to a page.
    await grid.locator(".dg-pager-page select").selectOption("3");
    await expect(grid.locator(".dg-pager-range")).toHaveText("51–60 of 60");
    await grid.getByRole("button", { name: "First page" }).click();

    // Sort by Total: ascending, descending, then back to the list's order.
    // The serial numbers follow the rows as shown, so row 1 is the cheapest.
    const totalHeader = grid.locator("thead th", { hasText: "Total" });
    const byTotal = [...ORDERS].sort((a, b) => a.total - b.total);
    await totalHeader.getByRole("button").click();
    await expect(totalHeader).toHaveAttribute("aria-sort", "ascending");
    expect(await serials(grid)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1)));
    expect(rupees((await columnText(grid, "total"))[0])).toBe(byTotal[0].total);
    expect((await columnText(grid, "number"))[0]).toBe(byTotal[0].number);
    // Sorting returns to page 1; page 2 of the sorted list still starts at 26.
    await grid.getByRole("button", { name: "Next page" }).click();
    expect((await serials(grid))[0]).toBe("26");
    expect(rupees((await columnText(grid, "total"))[0])).toBe(byTotal[25].total);
    await totalHeader.getByRole("button").click();
    await expect(totalHeader).toHaveAttribute("aria-sort", "descending");
    await expect(grid.locator(".dg-pager-range")).toHaveText("1–25 of 60");
    expect(rupees((await columnText(grid, "total"))[0])).toBe(byTotal[59].total);
    await totalHeader.getByRole("button").click();
    await expect(totalHeader).toHaveAttribute("aria-sort", "none");
    expect((await columnText(grid, "number"))[0]).toBe("PO-1001");

    // Text sorts the way people count ("PO-1009" before "PO-1010").
    const numberHeader = grid.locator("thead th", { hasText: "PO no." });
    await numberHeader.getByRole("button").click();
    await numberHeader.getByRole("button").click();
    expect((await columnText(grid, "number"))[0]).toBe("PO-1060");
    await numberHeader.getByRole("button").click();

    // Search goes back to page 1 and totals follow the filtered rows.
    const search = grid.getByRole("searchbox", { name: /Search/ });
    await grid.getByRole("button", { name: "Next page" }).click();
    await search.fill("spice");
    const spice = ORDERS.filter((order) => order.supplier === "Spice Bazaar");
    await expect(rowsOf(grid)).toHaveCount(spice.length);
    await expect(grid.locator(".dg-pager-range")).toHaveText(`Showing all ${spice.length}`);
    expect((await serials(grid))[0]).toBe("1");
    await expect(grid.locator(".dg-total-label")).toHaveText(`Total · ${spice.length} rows`);
    await expect(grid.locator(".dg-total-row td.type-money")).toHaveText(exact(spice.reduce((sum, order) => sum + order.total, 0)));

    // Filters: a status select under the headers narrows it further.
    await grid.getByRole("button", { name: "Filters" }).click();
    await grid.getByRole("combobox", { name: "Filter Status" }).selectOption("received");
    const both = spice.filter((order) => order.status === "received");
    await expect(rowsOf(grid)).toHaveCount(both.length);
    expect(await columnText(grid, "number")).toEqual(both.map((order) => order.number));
    await expect(grid.getByRole("button", { name: "Filters" })).toContainText("1");

    // Nothing matches: the grid says so and offers the way back.
    await search.fill("no such supplier");
    await expect(grid.getByText("No rows match")).toBeVisible();
    await grid.getByRole("button", { name: "Clear search and filters" }).click();
    await expect(rowsOf(grid)).toHaveCount(25);
    await expect(grid.locator(".dg-pager-range")).toHaveText("1–25 of 60");

    // Selection: the bulk bar counts the rows picked.
    await grid.getByRole("checkbox", { name: "Select PO-1001" }).check();
    await grid.getByRole("checkbox", { name: "Select PO-1002" }).check();
    await expect(grid.locator(".dg-bulk")).toContainText("2 selected");
    await expect(grid.locator(".fx-bulk")).toHaveText("2 ready");
    await grid.getByRole("checkbox", { name: "Select every row on this page" }).check();
    await expect(grid.locator(".dg-bulk")).toContainText("25 selected");
    await grid.locator(".dg-bulk").getByRole("button", { name: "Clear" }).click();
    await expect(grid.locator(".dg-bulk")).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test("layout is remembered: rows per page, hidden columns, widths; CSV export", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page);
    const grid = list(page);

    // 50 a page, and still 50 after a reload.
    await grid.getByRole("combobox", { name: "Rows per page" }).selectOption("50");
    await expect(rowsOf(grid)).toHaveCount(50);
    await expect(grid.locator(".dg-pager-range")).toHaveText("1–50 of 60");
    await grid.getByRole("button", { name: "Next page" }).click();
    expect((await serials(grid))[0]).toBe("51");

    // Hide Supplier from the column menu.
    await grid.getByRole("button", { name: "Columns" }).click();
    const menu = page.getByRole("dialog", { name: "Columns and row height" });
    await menu.getByRole("checkbox", { name: "Supplier" }).uncheck();
    await expect(menu.getByRole("checkbox", { name: "PO no." })).toBeDisabled();
    await menu.getByRole("radio", { name: "Compact" }).click();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(grid.locator("thead th", { hasText: "Supplier" })).toHaveCount(0);
    await expect(grid.locator(".dg")).toHaveClass(/is-compact/);

    // Resize Date with the keyboard (+48px) and with the pointer (+60px).
    const dateHead = grid.locator("thead th", { hasText: "Date" });
    const handle = grid.getByRole("separator", { name: "Resize Date column" });
    const before = (await dateHead.boundingBox()).width;
    await handle.focus();
    for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
    await expect.poll(async () => Math.round((await dateHead.boundingBox()).width)).toBeGreaterThanOrEqual(Math.round(before + 44));
    const afterKeys = (await dateHead.boundingBox()).width;
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 3 });
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 3 });
    await page.mouse.up();
    await expect.poll(async () => Math.round((await dateHead.boundingBox()).width)).toBeGreaterThanOrEqual(Math.round(afterKeys + 55));
    const resized = Math.round((await dateHead.boundingBox()).width);
    await shot(page, "fixture-1440-layout");

    // Everything survives a reload.
    await page.reload();
    await expect(rowsOf(grid)).toHaveCount(50);
    await expect(grid.locator("thead th", { hasText: "Supplier" })).toHaveCount(0);
    await expect(grid.locator(".dg")).toHaveClass(/is-compact/);
    expect(Math.abs(Math.round((await dateHead.boundingBox()).width) - resized)).toBeLessThanOrEqual(1);

    // Double-click the edge: fits the column to its widest content.
    await handle.dblclick();
    await expect.poll(async () => Math.round((await dateHead.boundingBox()).width)).toBeLessThan(resized);

    // Reset layout brings Supplier back; rows per page is the pager's own choice and stays.
    await grid.getByRole("button", { name: "Columns" }).click();
    await page.getByRole("button", { name: "Reset layout" }).click();
    await expect(grid.locator("thead th", { hasText: "Supplier" })).toHaveCount(1);
    await expect(grid.locator(".dg")).toHaveClass(/is-comfortable/);

    // CSV: S.No. first, visible columns, every filtered row in the shown
    // order, money as plain numbers, dates as YYYY-MM-DD.
    await grid.locator("thead th", { hasText: "Total" }).getByRole("button").click();
    await grid.locator("thead th", { hasText: "Total" }).getByRole("button").click();
    const [download] = await Promise.all([page.waitForEvent("download"), grid.getByRole("button", { name: "Export CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/^fx-orders-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readCsv(await download.path());
    const lines = csv.split("\n");
    expect(lines[0]).toBe('"S.No.","PO no.","Supplier","Status","Date","Total"');
    expect(lines).toHaveLength(61);
    const top = [...ORDERS].sort((a, b) => b.total - a.total)[0];
    expect(lines[1]).toBe(`"1","${top.number}","${top.supplier}","${top.status.charAt(0).toUpperCase() + top.status.slice(1)}","${top.date}","${top.total}"`);
    expect(lines[60].startsWith('"60",')).toBe(true);
  });

  test("phones: cards at 390px, no sideways page scroll", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openFixture(page);
    const grid = list(page);

    await expect(grid.locator(".dg")).toHaveClass(/is-cards/);
    await expect(grid.locator("table")).toHaveCount(0);
    const cards = grid.locator(".dg-cards > .dg-card");
    await expect(cards).toHaveCount(25);
    await expect(cards.first().locator(".dg-card-serial")).toHaveText("#1");
    await expect(cards.first().locator(".dg-card-title")).toHaveText("PO-1001");
    await expect(cards.first().locator("dt")).toHaveText(["Supplier", "Date", "Total"]);
    await expect(grid.getByRole("button", { name: "Columns" })).toHaveCount(0);
    await expect(grid.locator(".dg-card-total")).toContainText("Total · 60 rows");

    // "Sort by" replaces the header clicks; numbering follows the new order.
    await grid.getByRole("combobox", { name: "Sort by" }).selectOption("total:desc");
    await expect(cards.first().locator(".dg-card-serial")).toHaveText("#1");
    const top = [...ORDERS].sort((a, b) => b.total - a.total)[0];
    await expect(cards.first().locator(".dg-card-title")).toHaveText(top.number);

    // Page 2 of the cards starts at #26; every pager control is a 44px target.
    await grid.getByRole("button", { name: "Next page" }).click();
    await expect(cards.first().locator(".dg-card-serial")).toHaveText("#26");
    for (const name of ["First page", "Previous page", "Next page", "Last page"]) {
      expect((await grid.getByRole("button", { name }).boundingBox()).height).toBeGreaterThanOrEqual(44);
    }

    // Filters open as a short form above the cards.
    await grid.getByRole("button", { name: "Filters" }).click();
    await grid.locator(".dg-filter-panel").getByRole("combobox", { name: "Status" }).selectOption("cancelled");
    await expect(cards).toHaveCount(15);

    const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(widths.page).toBeLessThanOrEqual(widths.view);
    await shot(page, "fixture-390-cards");
  });

  test("row tones: one even tint across pinned and unpinned cells, light and dark, with hover", async ({ page }) => {
    // Narrow enough that the table scrolls sideways under its pinned columns.
    await page.setViewportSize({ width: 720, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openFixture(page);
    const grid = list(page);
    const paint = (row) => row.locator(":scope > td").evaluateAll((cells) => cells.map((td) => getComputedStyle(td).backgroundColor));
    const plainRow = grid.locator("tbody > tr.dg-row:not(.dg-tone-danger):not(.dg-tone-success)").first();

    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      for (const scrolled of [0, 160]) {
        await grid.locator(".dg-scroll").evaluate((box, left) => {
          box.scrollLeft = left;
          box.dispatchEvent(new Event("scroll"));
        }, scrolled);
        const plain = (await paint(plainRow))[0];

        for (const tone of ["dg-tone-danger", "dg-tone-success"]) {
          const row = grid.locator(`tbody > tr.${tone}`).first();
          // S.No., checkbox and PO no. are pinned; every cell carries one tint.
          expect(await row.locator(":scope > td.is-pinned").count()).toBeGreaterThanOrEqual(2);
          const resting = await paint(row);
          expect(new Set(resting).size, `${tone} ${colorScheme} at rest`).toBe(1);
          expect(resting[0]).not.toBe(plain);

          await row.locator("td[data-col='date']").hover();
          const hovered = await paint(row);
          expect(new Set(hovered).size, `${tone} ${colorScheme} under the pointer`).toBe(1);
          expect(hovered[0]).not.toBe(resting[0]);
          await page.mouse.move(1, 1);
        }
      }
    }
    await shot(page, "fixture-720-dark-tones");

    // The row's actions stay at the right edge of the wide table: the Open
    // button is in view without scrolling, with a shadow while columns hide
    // beneath it, and it stays there when scrolled.
    const box = grid.locator(".dg-scroll");
    for (const left of [0, 9999]) {
      await box.evaluate((node, to) => {
        node.scrollLeft = to;
        node.dispatchEvent(new Event("scroll"));
      }, left);
      const actions = grid.locator("tbody > tr.dg-row").first().locator("td.type-actions");
      await expect(actions).toHaveClass(/is-pinned-right/);
      const [cell, frame] = [await actions.boundingBox(), await box.boundingBox()];
      expect(Math.abs(cell.x + cell.width - (frame.x + frame.width))).toBeLessThanOrEqual(2);
      await expect(actions.getByRole("button", { name: "Open" })).toBeInViewport();
      await expect(box).toHaveClass(left === 0 ? /has-more-right/ : /^(?!.*has-more-right).*$/);
    }
  });

  test("server mode: rows per page remembered, currency, refunds, row noun", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page);
    const grid = page.locator("#fx-server");
    const aed = (value) => `AED ${new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
    const amounts = ORDERS.map((order, i) => (i === 1 ? -order.total : order.total));
    const sum = amounts.reduce((total, value) => total + Math.round(value * 100), 0) / 100;

    // The grid's currency on cells and totals; a refund reads "−AED 370.50".
    await expect(rowsOf(grid)).toHaveCount(25);
    expect((await columnText(grid, "total"))[0]).toBe(aed(ORDERS[0].total));
    expect((await columnText(grid, "total"))[1]).toBe(`−${aed(ORDERS[1].total)}`);
    await expect(grid.locator(".dg-total-label")).toHaveText("Total · 60 orders");
    await expect(grid.locator(".dg-total-row td.type-money")).toHaveText(sum < 0 ? `−${aed(-sum)}` : aed(sum));

    // CSV headings name the currency; refunds stay plain negative numbers.
    const [download] = await Promise.all([page.waitForEvent("download"), grid.getByRole("button", { name: "Export CSV" }).click()]);
    const lines = readCsv(await download.path()).split("\n");
    expect(lines[0]).toBe('"S.No.","PO no.","Supplier","Total (AED)"');
    expect(lines[2]).toBe(`"2","${ORDERS[1].number}","${ORDERS[1].supplier}","${-ORDERS[1].total}"`);

    // Rows per page: chosen once, remembered for this id across a reload,
    // where the grid hands it back to the page as it mounts.
    await grid.getByRole("combobox", { name: "Rows per page" }).selectOption("50");
    await expect(rowsOf(grid)).toHaveCount(50);
    await grid.getByRole("button", { name: "Next page" }).click();
    expect((await serials(grid))[0]).toBe("51");
    await page.reload();
    await expect(rowsOf(grid)).toHaveCount(50);
    expect(await page.evaluate(() => window.__serverCalls)).toEqual([{ page: 1, pageSize: 50, sort: null, filters: {} }]);
    await expect(grid.locator(".dg-pager-range")).toHaveText("1–50 of 60");
  });

  test("narrow columns, stable pinned order, compact table in a dialog-sized box, id swap", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page);
    const small = page.locator("#fx-small");

    // A 460px compact grid with four short columns stays a table.
    await expect(small.locator(".dg")).toHaveClass(/is-table/);
    // Order as the page gave it: the narrow "#" stays ahead of the title, and
    // both are pinned (pinning never moves a column forward).
    await expect(small.locator("thead th")).toHaveText(["S.No.", "#", "Dish name", "Quantity sold today", "Kitchen note"]);
    await expect(small.locator("thead th.is-pinned")).toHaveCount(3);
    // A narrow heading wraps to two lines instead of being cut, and a column
    // of words is never narrower than about 110px.
    const label = small.locator("thead th", { hasText: "Quantity sold today" }).locator(".dg-head-label");
    const box = await label.evaluate((node) => ({ lines: Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)), cut: node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1 }));
    expect(box.lines).toBe(2);
    expect(box.cut).toBe(false);
    expect((await small.locator("thead th", { hasText: "Kitchen note" }).boundingBox()).width).toBeGreaterThanOrEqual(109);
    // No step in the row lines where the pinned columns end.
    const lines = await small.locator("tbody tr.dg-row").first().locator(":scope > td").evaluateAll((cells) => cells.map((td) => { const r = td.getBoundingClientRect(); return [Math.round(r.bottom * 10), getComputedStyle(td).borderBottomWidth]; }));
    expect(new Set(lines.map(([bottom, width]) => `${bottom}/${width}`)).size).toBe(1);

    // On a phone the same table becomes cards (it no longer fits).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#fx-small").evaluate((node) => { node.style.width = "340px"; });
    await expect(small.locator(".dg")).toHaveClass(/is-cards/);
    await page.setViewportSize({ width: 1440, height: 900 });

    // Two lists in one place, told apart by id: sorted state, rows and
    // layout belong to each list; swapping back and forth just works.
    const swap = page.locator("#fx-swap");
    await swap.getByRole("button", { name: "Item" }).click();
    await swap.getByRole("button", { name: "Item" }).click();
    await expect(swap.locator("thead th", { hasText: "Item" })).toHaveAttribute("aria-sort", "descending");
    await swap.getByRole("button", { name: "Swap list" }).click();
    await expect(swap.locator("thead th").nth(1)).toHaveText("Supplier");
    expect(await columnText(swap, "label")).toEqual(["Fresh Farm", "Spice Bazaar"]);
    await expect(swap.locator("thead th", { hasText: "Supplier" })).toHaveAttribute("aria-sort", "none");
    await swap.getByRole("button", { name: "Swap list" }).click();
    expect(await columnText(swap, "name")).toEqual(["Onions", "Tomatoes", "Ginger"]);
    await expect(swap.locator("thead th", { hasText: "Item" })).toHaveAttribute("aria-sort", "none");
    expect(errors).toEqual([]);
  });

  test("editor variant: numbered lines, Enter moves down, totals, phone cards", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openFixture(page);
    const editor = page.locator("#fx-editor");

    await expect(editor.locator("thead th").first()).toHaveText("S.No.");
    expect(await serials(editor)).toEqual(["1", "2", "3"]);
    // No sorting, search, paging or export in an entry table.
    await expect(editor.locator(".dg-sort")).toHaveCount(0);
    await expect(editor.locator(".dg-toolbar, .dg-pager")).toHaveCount(0);
    await expect(editor.locator(".dg-total-row td.type-money").last()).toHaveText(exact(10 * 92 + 5 * 128 + 2 * 610));

    // Enter in a field goes to the same field on the next line, never submits.
    const qty1 = editor.getByRole("spinbutton", { name: "Qty, line 1" });
    await qty1.fill("11");
    await qty1.press("Enter");
    await expect(editor.getByRole("spinbutton", { name: "Qty, line 2" })).toBeFocused();
    await page.keyboard.press("Shift+Enter");
    await expect(qty1).toBeFocused();
    expect(await page.evaluate(() => window.__submitted || 0)).toBe(0);
    await expect(editor.locator(".dg-total-row td.type-money").last()).toHaveText(exact(11 * 92 + 5 * 128 + 2 * 610));
    await expect(editor.locator(".dg-total-row td.type-number")).toHaveText("18");
    await expect(editor.locator(".dg-total-label")).toHaveText("Total · 3 lines");
    await shot(page, "fixture-1440-editor");

    // On a phone each line is a card: "Line 1", inputs stacked under labels.
    await page.setViewportSize({ width: 390, height: 844 });
    const lineCards = editor.locator(".dg-cards > .dg-card");
    await expect(lineCards).toHaveCount(3);
    await expect(lineCards.first().locator(".dg-card-serial")).toHaveText("Line 1");
    await expect(lineCards.first().locator("label", { hasText: "Qty" }).locator("input")).toHaveValue("11");
    await lineCards.first().locator("label", { hasText: "Rate" }).locator("input").press("Enter");
    await expect(lineCards.nth(1).locator("label", { hasText: "Rate" }).locator("input")).toBeFocused();
    await expect(editor.locator(".dg-card-total")).toContainText("Total · 3 lines");
    await editor.scrollIntoViewIfNeeded();
    await shot(page, "fixture-390-editor");
  });
});

// --- The two converted screens ---------------------------------------------------------

const signIn = async (page, account) => {
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  try {
    await expect(page.locator("main.content-scroll")).toBeVisible();
  } finally {
    const passwordInput = page.locator('input[autocomplete="current-password"]');
    if (await passwordInput.count()) await passwordInput.fill("");
  }
};

test.describe("converted screens", () => {
  test("Outlets: grid, sort, page, export, phone cards", async ({ page }) => {
    test.skip(!admin, "Set E2E_CREDENTIALS_FILE to the gitignored demo credentials file.");
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => response.status() >= 500 && errors.push(`${response.status()} ${response.url()}`));
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, admin);
    await page.goto("/restaurant/outlets");
    const grid = page.locator(".dg").first();
    // Five hundred outlets on the test database: give the first load time.
    await expect(rowsOf(grid).first()).toBeVisible({ timeout: 20_000 });
    await expect(grid.locator("thead th").first()).toHaveText("S.No.");
    await expect(grid.getByRole("button", { name: "Name" })).toBeVisible();

    const count = await rowsOf(grid).count();
    expect(count).toBeGreaterThan(0);
    expect((await serials(grid))[0]).toBe("1");

    // Sort by name: the header says so; the numbers still start at 1.
    const nameHeader = grid.locator("thead th", { hasText: "Name" });
    await nameHeader.getByRole("button").click();
    await expect(nameHeader).toHaveAttribute("aria-sort", "ascending");
    expect((await serials(grid))[0]).toBe("1");

    if (await grid.getByRole("button", { name: "Next page" }).count()) {
      await grid.getByRole("button", { name: "Next page" }).click();
      expect((await serials(grid))[0]).toBe("26");
    }

    const [download] = await Promise.all([page.waitForEvent("download"), grid.getByRole("button", { name: "Export CSV" }).click()]);
    const csv = readCsv(await download.path());
    // The headings, not the exact row: other jobs add outlet columns. S.No.
    // leads, the grid's own columns follow, actions are never exported.
    const headings = csv.split("\n")[0].split(",").map((cell) => cell.replace(/^"|"$/g, ""));
    expect(headings[0]).toBe("S.No.");
    expect(headings[1]).toBe("Name");
    for (const heading of ["Code", "GSTIN", "Contact", "Address", "Status"]) expect(headings).toContain(heading);
    expect(headings).not.toContain("Actions");
    expect(headings).toHaveLength(await grid.locator("thead tr.dg-head-row > th:not(.type-actions)").count());

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(grid).toHaveClass(/is-cards/);
    await expect(grid.locator(".dg-card-serial").first()).toHaveText(/^#\d+$/);
    const widths = await page.evaluate(() => ({ main: document.querySelector("main.content-scroll").scrollWidth, view: document.querySelector("main.content-scroll").clientWidth }));
    expect(widths.main).toBeLessThanOrEqual(widths.view);
    expect(errors).toEqual([]);
  });

  test("Platform restaurants: server paging numbers on from 26", async ({ page }) => {
    test.skip(!platformOwner, "Needs a SUPER_ADMIN account in E2E_CREDENTIALS_FILE.");
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => response.status() >= 500 && errors.push(`${response.status()} ${response.url()}`));
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page, platformOwner);
    await page.goto("/platform/restaurants");
    const grid = page.locator(".dg").first();
    await expect(rowsOf(grid).first()).toBeVisible({ timeout: 20_000 });
    // The API does not sort, so the headers do not offer to.
    await expect(grid.locator(".dg-sort")).toHaveCount(0);
    expect((await serials(grid))[0]).toBe("1");

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/users/platform/restaurants") && req.url().includes("offset=25")),
      grid.getByRole("button", { name: "Next page" }).click(),
    ]);
    expect(new URL(request.url()).searchParams.get("limit")).toBe("25");
    await expect(grid.locator(".dg-pager-range")).toContainText("26–50");
    await expect.poll(async () => (await serials(grid))[0]).toBe("26");

    await grid.getByRole("combobox", { name: "Rows per page" }).selectOption("50");
    await expect(grid.locator(".dg-pager-range")).toContainText("1–50");
    await expect(rowsOf(grid)).toHaveCount(50);

    // Remembered: after a reload the very first request already asks for 50.
    const [first] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("/users/platform/restaurants")),
      page.reload(),
    ]);
    expect(new URL(first.url()).searchParams.get("limit")).toBe("50");
    await expect(rowsOf(grid)).toHaveCount(50, { timeout: 20_000 });

    // Search is answered by the API and goes back to the first page.
    await grid.getByRole("searchbox").fill("FoodEx");
    await expect(rowsOf(grid).first()).toContainText("FoodEx");
    expect((await serials(grid))[0]).toBe("1");
    expect(errors).toEqual([]);
  });
});
