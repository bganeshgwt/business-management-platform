const purchaseReturnRepository = require("../repositories/purchaseReturn.repository");
const supplierRepository = require("../repositories/supplier.repository");
const inventoryRepository = require("../../inventory/repositories/inventory.repository");
const purchaseRepository = require("../repositories/purchase.repository");
const businessDayRepository = require("../../business-day/repositories/businessDay.repository");
const { openDayOf } = require("../../business-day/services/tradingDay");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { checkAmount } = require("../../../../utils/amountLimit");

const round3 = (value) => Math.round(Number(value) * 1000) / 1000;
const round8 = (value) => Math.round(Number(value) * 1e8) / 1e8;

// A credit price may sit this far above the price paid and still be the same
// price: a per-ml cost typed to four decimals (0.1366 for 0.13658333).
const PRICE_SLACK = 0.0001;

const money4 = (value) => {
  const rounded = Math.round(Number(value) * 10000) / 10000;
  return Number.isInteger(rounded * 100) ? rounded.toFixed(2) : String(rounded);
};

const requireRestaurantId = (restaurantId) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }
};

const toReturn = (row) => ({
  id: row.id,
  returnNumber: row.return_number,
  returnDate: row.return_date,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  // For the printed debit note: who it is made out to.
  supplierGstin: row.supplier_gstin ?? null,
  supplierAddress: row.supplier_address ?? null,
  supplierMobile: row.supplier_mobile ?? null,
  purchaseOrderId: row.purchase_order_id,
  poNumber: row.po_number,
  goodsReceiptId: row.goods_receipt_id ?? null,
  receiptNumber: row.receipt_number ?? null,
  billNumber: row.bill_number ?? null,
  billDate: row.bill_date ?? null,
  taxableAmount: Number(row.taxable_amount ?? row.total_amount),
  taxAmount: Number(row.tax_amount ?? 0),
  totalAmount: Number(row.total_amount),
  reason: row.reason,
  notes: row.notes,
  status: row.return_status || "posted",
  voidReason: row.void_reason ?? null,
  voidedAt: row.voided_at ?? null,
  voidedByName: row.voided_by_name ?? null,
  createdAt: row.created_at,
  createdByName: row.created_by_name ?? null,
  itemCount: row.item_count ?? (row.items ? row.items.length : undefined),
  items: (row.items || []).map((item) => ({
    id: item.id,
    inventoryItemId: item.inventory_item_id,
    goodsReceiptItemId: item.goods_receipt_item_id ?? null,
    itemName: item.item_name,
    unitShortName: item.unit_short_name,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    taxRate: Number(item.tax_rate || 0),
    taxAmount: Number(item.tax_amount || 0),
    amount: Number(item.amount),
    // On a return's own page: the most this line may be corrected to, per
    // unit before GST (null: nothing on record, so only ₹0), and what that
    // limit comes from ("bill", "order", "supplier" or "cost").
    ...(item.max_basis !== undefined
      ? { maxUnitPrice: item.max_unit_price, maxBasis: item.max_basis }
      : {}),
  })),
});

// A page of a list with how many match in all ({ items, total, limit,
// offset }) when the screen pages; past the last page the count is read from
// the first row.
const pageOf = async (find, restaurantId, filters, toRow) => {
  const rows = await find(restaurantId, filters);
  let total = rows.length ? rows[0].total_count : 0;

  if (!rows.length && filters.offset > 0) {
    const first = await find(restaurantId, { ...filters, offset: 0, limit: 1 });
    total = first.length ? first[0].total_count : 0;
  }

  return { items: rows.map(toRow), total, limit: filters.limit, offset: filters.offset || 0 };
};

// The whole list (up to 200, as before) — or, when the screen pages
// (filters.paged), one page of it with the total.
const list = async (restaurantId, filters) => {
  requireRestaurantId(restaurantId);

  if (filters && filters.paged) {
    return pageOf(purchaseReturnRepository.findAll, restaurantId, filters, toReturn);
  }

  const rows = await purchaseReturnRepository.findAll(restaurantId, filters);
  return rows.map(toReturn);
};

const getById = async (restaurantId, id) => {
  requireRestaurantId(restaurantId);

  const row = await purchaseReturnRepository.findById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Purchase return not found");
  }

  // The earliest day a correction may date it to, for the date box's minimum.
  const arrivedOn = await arrivalOf(restaurantId, row.goods_receipt_id, row.purchase_order_id);

  return { ...toReturn(await withCreditLimits(restaurantId, row)), goodsArrivedOn: arrivedOn ? arrivedOn.date : null };
};

// When the goods a return names first arrived, and how to say it: the bill's
// delivery for a return tied to a bill, the order's first delivery for one
// tied to an order. Null for a return tied to nothing.
const arrivalOf = async (restaurantId, goodsReceiptId, purchaseOrderId) => {
  if (goodsReceiptId) {
    const receipt = await purchaseRepository.findReceiptById(restaurantId, goodsReceiptId);

    return receipt && receipt.received_date
      ? { date: receipt.received_date, words: `The goods on ${receipt.bill_number ? `bill ${receipt.bill_number}` : receipt.receipt_number} arrived on ${receipt.received_date}` }
      : null;
  }

  if (purchaseOrderId) {
    const date = await purchaseReturnRepository.findFirstArrival(restaurantId, purchaseOrderId);
    const order = date ? await purchaseRepository.findById(restaurantId, purchaseOrderId) : null;

    return date ? { date, words: `The first goods on ${order ? order.po_number : "this order"} arrived on ${date}` } : null;
  }

  return null;
};

// Goods cannot go back before they came in: the check a new return and a
// corrected date both meet, for a return tied to a bill or to an order. A
// return tied to an order used to be checked against nothing, so one dated
// 19 Sept for goods that arrived on 22 Sept put a credit on the supplier's
// statement before the bill it came off.
const checkReturnDate = async (restaurantId, returnDate, goodsReceiptId, purchaseOrderId) => {
  if (!returnDate) {
    return;
  }

  const arrived = await arrivalOf(restaurantId, goodsReceiptId, purchaseOrderId);

  if (arrived && returnDate < arrived.date) {
    throw new AppError(400, `${arrived.words}, so the return cannot be dated before that`);
  }
};

// A credit line: the price is per unit of stock, before GST; GST at the rate
// the goods were bought at is credited on top.
const priceReturnLine = (quantity, unitPrice, taxRate) => {
  const taxable = round2(quantity * unitPrice);
  const tax = round2((taxable * taxRate) / 100);

  return { taxable, taxAmount: tax, amount: round2(taxable + tax) };
};

const requireSupplier = async (restaurantId, supplierId) => {
  const supplier = await supplierRepository.findById(restaurantId, supplierId);

  if (!supplier) {
    throw new AppError(400, "Selected supplier does not exist");
  }

  return supplier;
};

const rateList = (rates) => rates.map((rate) => `${rate}%`).join(" or ");

// --- What a credit line may be -------------------------------------------------
//
// Every credit is held to what was actually paid, whatever the return is tied
// to. A slip of the keyboard (₹99,999 for a kilo of paneer) must never wipe out
// what is owed to a supplier, and a debit note carries the GST rate the goods
// were bought at. The same rule is used when a return is entered and when it
// is corrected: a correction used to be checked only for returns tied to a
// bill or to nothing, so a return tied to an order could be corrected to any
// price.
//
// A rule is { maxPrice, rates, basis, source }:
//   maxPrice — the most per unit of stock, before GST (null: nothing on record)
//   rates    — the GST rates the credit may carry, latest first (null: any slab)
//   basis    — "bill", "order", "supplier" (the most this supplier ever billed)
//              or "cost" (what the item costs today, GST included)
//   source   — how the screen and the messages name it ("bill 4521", "PO-0012")

// A line tied to a bill: the price paid on that bill, at its GST rate.
const billLineRule = (bought, source) => ({
  maxPrice: Number(bought.received) > 0 ? round8(Number(bought.taxable_amount) / Number(bought.received)) : 0,
  rates: [Number(bought.tax_rate || 0)],
  basis: "bill",
  source,
});

// A line tied to an order: the most any of its bills charged for the item,
// at the rates they charged. An order received before bills were kept here
// falls back to the price it was raised at.
const orderLineRule = (bought, source) => {
  const rates = (bought.tax_rates || []).map(Number);

  return {
    maxPrice:
      bought.paid_max !== null && bought.paid_max !== undefined
        ? round8(Number(bought.paid_max))
        : Number(bought.unit_price || 0),
    rates: rates.length > 0 ? rates : null,
    basis: "order",
    source,
  };
};

// A line tied to nothing (goods from before the system, say): the most this
// supplier has ever billed for the item, at the rates they billed it. For
// goods they never billed here, what the item costs today, which already has
// GST in it, so the credit with its GST cannot come to more than that.
const unlinkedRule = async (restaurantId, supplier, itemId) => {
  const ceiling = await purchaseReturnRepository.findCreditCeiling(restaurantId, supplier.id, itemId);

  if (ceiling.supplierMax !== null) {
    return {
      maxPrice: round8(ceiling.supplierMax),
      rates: ceiling.supplierRates.length > 0 ? ceiling.supplierRates : null,
      basis: "supplier",
      source: supplier.name,
    };
  }

  return { maxPrice: ceiling.lastCost, rates: null, basis: ceiling.lastCost === null ? null : "cost", source: supplier.name };
};

// The GST rate a line is credited at. A bill's own rate is used as it is (the
// screen shows it and has no choice). Otherwise a rate that was never charged
// on these goods is refused, and none given means the latest one charged.
const pickRate = (rule, requested, stockItem) => {
  if (!rule.rates) {
    return requested ?? 0;
  }

  if (rule.basis === "bill" || requested === null || requested === undefined) {
    return rule.rates[0];
  }

  if (!rule.rates.includes(Number(requested))) {
    throw new AppError(
      400,
      rule.basis === "supplier"
        ? `${rule.source} billed ${stockItem.name} at ${rateList(rule.rates)} GST. A return is credited at the rate the goods were bought at.`
        : `${stockItem.name} was billed at ${rateList(rule.rates)} GST on ${rule.source}. A return is credited at the rate the goods were bought at.`
    );
  }

  return Number(requested);
};

// The credit price per unit (before GST) against the rule.
const checkPrice = (rule, unitPrice, taxRate, stockItem) => {
  if (unitPrice <= 0) {
    return;
  }

  const unit = stockItem.unit_short_name;

  if (rule.maxPrice === null) {
    throw new AppError(
      400,
      `No price is on record for ${stockItem.name}, so a credit cannot be checked. Choose the bill it came on, or enter the return at ₹0.`
    );
  }

  if (rule.basis === "cost") {
    // The cost has GST in it; the credit is before GST, with GST on top.
    if (round8(unitPrice * (1 + taxRate / 100)) > rule.maxPrice + PRICE_SLACK) {
      throw new AppError(
        400,
        `${stockItem.name} costs ₹${money4(rule.maxPrice)} a ${unit} with GST, so the credit with ${taxRate}% GST cannot be more than that. Choose the bill it came on if it was a different price.`
      );
    }

    return;
  }

  if (unitPrice > rule.maxPrice + PRICE_SLACK) {
    const messages = {
      bill: `${stockItem.name} was bought at ₹${money4(rule.maxPrice)} a ${unit} before GST on ${rule.source}; the credit cannot be more than that`,
      order: `${stockItem.name} was billed at no more than ₹${money4(rule.maxPrice)} a ${unit} before GST on ${rule.source}; the credit cannot be more than that`,
      supplier: `${rule.source} has never billed ${stockItem.name} above ₹${money4(rule.maxPrice)} a ${unit} before GST, so the credit cannot be more than that. Choose the bill if it was a different price.`,
    };

    throw new AppError(400, messages[rule.basis]);
  }
};

// What a credit may be for one item, for the return screen to show before
// anything is saved: the ceiling, and the GST rates it may carry.
const creditLimit = async (restaurantId, { supplierId, itemId }) => {
  requireRestaurantId(restaurantId);

  const supplier = await supplierRepository.findById(restaurantId, supplierId);

  if (!supplier) {
    throw new AppError(404, "Supplier not found");
  }

  const item = await inventoryRepository.findItemById(restaurantId, itemId);

  if (!item) {
    throw new AppError(404, "Item not found");
  }

  const rule = await unlinkedRule(restaurantId, supplier, item.id);
  const [supply] = await purchaseReturnRepository.findSupplierReturnable(restaurantId, supplier.id, [item.id]);

  return {
    supplierId: supplier.id,
    inventoryItemId: item.id,
    maxUnitPrice: rule.maxPrice,
    rates: rule.rates,
    basis: rule.basis,
    // How much can still go back to this supplier: what they supplied less
    // what already went back to them.
    supplied: round3(supply.supplied),
    returned: round3(supply.returned),
    maxQuantity: Math.max(round3(supply.supplied - supply.returned), 0),
  };
};

// A return is checked against what was actually bought: the bill (or order)
// it names must be this supplier's, every item must be on it, no more can go
// back than came in less what already went back, and the credit cannot be
// more than was paid. Returns not tied to a bill are still allowed — goods
// from before the system, say — but they are priced by hand.
const create = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const supplier = await requireSupplier(restaurantId, data.supplierId);

  if (data.items.length === 0) {
    throw new AppError(400, "Add at least one item to return");
  }

  let storeOutletId = data.outletId || null;
  let purchaseOrderId = data.purchaseOrderId || null;
  let returnable = null;
  let source = null;

  if (data.goodsReceiptId) {
    const receipt = await purchaseRepository.findReceiptById(restaurantId, data.goodsReceiptId);

    if (!receipt) {
      throw new AppError(400, "Selected purchase bill does not exist");
    }

    if (Number(receipt.supplier_id) !== Number(supplier.id)) {
      throw new AppError(400, `${receipt.receipt_number} is ${receipt.supplier_name}'s bill, not ${supplier.name}'s`);
    }

    if (receipt.receipt_status !== "posted") {
      throw new AppError(400, `${receipt.receipt_number} was voided; nothing can be returned against it`);
    }

    source = receipt.bill_number ? `bill ${receipt.bill_number}` : receipt.receipt_number;

    // Goods cannot go back before they came in.
    await checkReturnDate(restaurantId, data.returnDate, receipt.id, null);

    returnable = await purchaseReturnRepository.findReturnable(restaurantId, { goodsReceiptId: receipt.id });
    storeOutletId = receipt.outlet_id;
    purchaseOrderId = receipt.purchase_order_id || null;
  } else if (purchaseOrderId) {
    const order = await purchaseRepository.findById(restaurantId, purchaseOrderId);

    if (!order) {
      throw new AppError(400, "Selected purchase order does not exist");
    }

    if (Number(order.supplier_id) !== Number(supplier.id)) {
      throw new AppError(400, `${order.po_number} was placed with ${order.supplier_name}, not ${supplier.name}`);
    }

    returnable = await purchaseReturnRepository.findReturnable(restaurantId, { purchaseOrderId });
    source = order.po_number;
    storeOutletId = order.outlet_id;

    await checkReturnDate(restaurantId, data.returnDate, null, purchaseOrderId);
  }

  const seen = new Set();
  const items = [];

  for (const item of data.items) {
    if (seen.has(item.inventoryItemId)) {
      throw new AppError(400, "The same item is listed twice");
    }

    seen.add(item.inventoryItemId);

    const stockItem = await inventoryRepository.findItemById(restaurantId, item.inventoryItemId);

    if (!stockItem) {
      throw new AppError(400, "One of the selected items does not exist");
    }

    let rule;
    let goodsReceiptItemId = null;

    if (returnable) {
      const bought = returnable.find((row) => Number(row.inventory_item_id) === Number(item.inventoryItemId));

      if (!bought) {
        throw new AppError(400, `${stockItem.name} is not on ${source}`);
      }

      const available = Math.max(round3(bought.available), 0);

      if (item.quantity > available + 0.0005) {
        throw new AppError(400, tooMuchMessage(stockItem.name, stockItem.unit_short_name, available, source, Number(bought.received)));
      }

      rule = data.goodsReceiptId ? billLineRule(bought, source) : orderLineRule(bought, source);
      goodsReceiptItemId = bought.goods_receipt_item_id || null;
    } else {
      rule = await unlinkedRule(restaurantId, supplier, stockItem.id);
    }

    // With no credit the rate does not matter; a return at ₹0 is never
    // refused over it.
    const taxRate =
      item.unitPrice > 0 ? pickRate(rule, item.taxRate, stockItem) : rule.rates ? rule.rates[0] : item.taxRate ?? 0;

    checkPrice(rule, item.unitPrice, taxRate, stockItem);

    const priced = priceReturnLine(item.quantity, item.unitPrice, taxRate);

    checkAmount(priced.amount, stockItem.name);

    items.push({
      inventoryItemId: item.inventoryItemId,
      goodsReceiptItemId,
      quantity: item.quantity,
      unitPrice: round8(item.unitPrice),
      taxRate,
      ...priced,
    });
  }

  const taxableAmount = round2(items.reduce((sum, item) => sum + item.taxable, 0));
  const taxAmount = round2(items.reduce((sum, item) => sum + item.taxAmount, 0));

  checkAmount(round2(taxableAmount + taxAmount), "This return");

  const result = await purchaseReturnRepository.create(
    restaurantId,
    {
      ...data,
      purchaseOrderId,
      items,
      taxableAmount,
      taxAmount,
      totalAmount: round2(taxableAmount + taxAmount),
      storeId: await inventoryRepository.storeFor(inventoryRepository.pool, restaurantId, storeOutletId),
    },
    userId
  );

  if (result.error === "BILL_VOID") {
    throw new AppError(400, `${result.receiptNumber || "That bill"} was voided; nothing can be returned against it`);
  }

  // Someone else returned the same goods between the check above and this one.
  if (result.error === "TOO_MUCH") {
    throw new AppError(400, tooMuchMessage(result.itemName, result.unit, result.available, source, null));
  }

  if (result.error === "SUPPLIER_CAP") {
    throw new AppError(400, supplierCapMessage(supplier.name, result));
  }

  if (result.error === "NEGATIVE_STOCK") {
    const item = await inventoryRepository.findItemById(restaurantId, result.inventoryItemId);
    const store = storeOutletId ? await inventoryRepository.findOutlet(restaurantId, storeOutletId) : null;
    const where = store && store.own_store ? store.name : "the main store";

    throw new AppError(
      400,
      item
        ? `Only ${round3(result.currentStock)} ${item.unit_short_name} of ${item.name} is in stock at ${where}, so no more than that can go back`
        : `Only ${round3(result.currentStock)} is in stock at ${where}`
    );
  }

  if (result.error) {
    throw new AppError(400, "One of the selected items does not exist");
  }

  return toReturn(result.purchaseReturn);
};

// How much more of an item can go back to a supplier at all, in words.
const supplierCapMessage = (supplierName, { itemName, unit, supplied, returnedBefore, available }) => {
  if (supplied <= 0) {
    return `${supplierName} has not supplied any ${itemName} here (no bill or delivery of it from them), so none can be returned to them. Stock from before you started using the system goes out with Stock out; the supplier takes the credit off their next bill.`;
  }

  if (available <= 0) {
    return `All ${supplied} ${unit} of ${itemName} that ${supplierName} has supplied here has already gone back to them, so no more can be returned`;
  }

  return `${supplierName} has supplied ${supplied} ${unit} of ${itemName} here and ${returnedBefore} ${unit} has already gone back, so only ${available} ${unit} more can be returned to them`;
};

// How much more of an item can go back against a bill or an order, in words.
const tooMuchMessage = (name, unit, available, source, received) => {
  if (received === 0) {
    return `No ${name} has been received on ${source} yet, so none can go back against it`;
  }

  return available > 0
    ? `Only ${available} ${unit} of ${name} from ${source} can still be returned`
    : `All the ${name} from ${source} has already been returned`;
};

// The rule for each line of a return already on record, by what it is tied
// to: its bill line, its order, or (tied to nothing) the supplier's history.
// Returns a function from a return line to its rule.
const creditRulesFor = async (restaurantId, existing) => {
  if (existing.goods_receipt_id) {
    const returnable = await purchaseReturnRepository.findReturnable(restaurantId, {
      goodsReceiptId: existing.goods_receipt_id,
    });
    const source = existing.bill_number ? `bill ${existing.bill_number}` : existing.receipt_number;

    return async (line) => {
      const bought = returnable.find((row) =>
        line.goods_receipt_item_id
          ? Number(row.goods_receipt_item_id) === Number(line.goods_receipt_item_id)
          : Number(row.inventory_item_id) === Number(line.inventory_item_id)
      );

      return bought ? billLineRule(bought, source) : { maxPrice: null, rates: null, basis: "bill", source };
    };
  }

  if (existing.purchase_order_id) {
    const returnable = await purchaseReturnRepository.findReturnable(restaurantId, {
      purchaseOrderId: existing.purchase_order_id,
    });

    return async (line) => {
      const bought = returnable.find((row) => Number(row.inventory_item_id) === Number(line.inventory_item_id));

      return bought
        ? orderLineRule(bought, existing.po_number)
        : { maxPrice: null, rates: null, basis: "order", source: existing.po_number };
    };
  }

  const supplier = await supplierRepository.findById(restaurantId, existing.supplier_id);

  return (line) => unlinkedRule(restaurantId, supplier, line.inventory_item_id);
};

// The most each line of a return may be credited at, for the correction
// screen to show next to the box.
const withCreditLimits = async (restaurantId, row) => {
  if (!row || row.return_status !== "posted") {
    return row;
  }

  const rules = await creditRulesFor(restaurantId, row);
  const items = [];

  for (const item of row.items) {
    const rule = await rules(item);

    items.push({ ...item, max_unit_price: rule.maxPrice, max_basis: rule.basis });
  }

  return { ...row, items };
};

const update = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await purchaseReturnRepository.findById(restaurantId, id);

  if (!existing) {
    throw new AppError(404, "Purchase return not found");
  }

  if (existing.return_status !== "posted") {
    throw new AppError(409, "A voided return cannot be changed");
  }

  const byId = new Map(existing.items.map((item) => [Number(item.id), item]));
  const changes = new Map(data.lines.map((line) => [Number(line.id), line.unitPrice]));

  for (const lineId of changes.keys()) {
    if (!byId.has(lineId)) {
      throw new AppError(400, "One of those lines is not on this return");
    }
  }

  await checkReturnDate(
    restaurantId,
    data.returnDate,
    existing.goods_receipt_id,
    existing.goods_receipt_id ? null : existing.purchase_order_id
  );

  const rules = await creditRulesFor(restaurantId, existing);
  const lines = [];

  for (const item of existing.items) {
    const changed = changes.has(Number(item.id));
    const unitPrice = changed ? changes.get(Number(item.id)) : Number(item.unit_price);
    const taxRate = Number(item.tax_rate || 0);

    // A changed price meets the same rule as a new return tied to the same
    // bill, order or nothing. A line left alone keeps what it had.
    if (changed) {
      const rule = await rules(item);

      checkPrice(rule, unitPrice, taxRate, {
        name: item.item_name,
        unit_short_name: item.unit_short_name,
      });
    }

    const priced = priceReturnLine(Number(item.quantity), unitPrice, taxRate);

    checkAmount(priced.amount, item.item_name);

    lines.push({ id: item.id, unitPrice: round8(unitPrice), ...priced });
  }

  const taxableAmount = round2(lines.reduce((sum, line) => sum + line.taxable, 0));
  const taxAmount = round2(lines.reduce((sum, line) => sum + line.taxAmount, 0));

  checkAmount(round2(taxableAmount + taxAmount), "This return");

  const result = await purchaseReturnRepository.update(
    restaurantId,
    id,
    {
      returnDate: data.returnDate || existing.return_date,
      reason: data.reason || existing.reason,
      notes: data.notes === undefined ? existing.notes : data.notes,
      lines,
      taxableAmount,
      taxAmount,
      totalAmount: round2(taxableAmount + taxAmount),
    },
    userId
  );

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Purchase return not found");
  }

  if (result.error === "VOID") {
    throw new AppError(409, "A voided return cannot be changed");
  }

  if (result.error) {
    throw new AppError(400, "One of those lines is not on this return");
  }

  return { before: toReturn(existing), after: toReturn(result.purchaseReturn) };
};

const voidReturn = async (restaurantId, id, reason, userId) => {
  requireRestaurantId(restaurantId);

  const result = await purchaseReturnRepository.voidReturn(restaurantId, id, reason, userId);

  if (result.error === "NOT_FOUND") {
    throw new AppError(404, "Purchase return not found");
  }

  if (result.error === "ALREADY_VOID") {
    throw new AppError(409, "This return is already voided");
  }

  return toReturn(result.purchaseReturn);
};

// --- Supplier payments ---

const toPayment = (row) => ({
  id: row.id,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  purchaseOrderId: row.purchase_order_id,
  poNumber: row.po_number,
  goodsReceiptId: row.goods_receipt_id ?? null,
  receiptNumber: row.receipt_number ?? null,
  billNumber: row.bill_number ?? null,
  paymentDate: row.payment_date,
  amount: Number(row.amount),
  paymentMethod: row.payment_method,
  referenceNo: row.reference_no,
  notes: row.notes,
  status: row.payment_status || "posted",
  voidReason: row.void_reason ?? null,
  voidedAt: row.voided_at ?? null,
  voidedByName: row.voided_by_name ?? null,
  paidFromTill: Boolean(row.paid_from_till),
  businessDate: row.business_date ?? null,
  // Whose drawer a till payment came out of (null: the main counter).
  tillOutletId: row.paid_from_till && row.outlet_id !== null && row.outlet_id !== undefined ? Number(row.outlet_id) : null,
  tillName: row.paid_from_till ? row.till_outlet_name || "Main counter" : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdByName: row.created_by_name,
});

const listPayments = async (restaurantId, filters = {}) => {
  requireRestaurantId(restaurantId);

  if (filters && typeof filters === "object" && filters.paged) {
    return pageOf(purchaseReturnRepository.findPayments, restaurantId, filters, toPayment);
  }

  const rows = await purchaseReturnRepository.findPayments(
    restaurantId,
    typeof filters === "object" && filters !== null ? filters : { supplierId: filters }
  );

  return rows.map(toPayment);
};

// A payment may name the order or bill it settles; either must be this
// supplier's. It used to accept any id at all, and an unknown one failed on
// the database with a bare "Internal server error".
const checkPaymentLinks = async (restaurantId, supplier, data) => {
  if (data.purchaseOrderId) {
    const order = await purchaseRepository.findById(restaurantId, data.purchaseOrderId);

    if (!order) {
      throw new AppError(400, "Selected purchase order does not exist");
    }

    if (Number(order.supplier_id) !== Number(supplier.id)) {
      throw new AppError(400, `${order.po_number} was placed with ${order.supplier_name}, not ${supplier.name}`);
    }

    // An advance against an order that will never come is money handed over
    // for nothing on record.
    if (order.po_status === "cancelled") {
      throw new AppError(400, `${order.po_number} was cancelled; record the payment against the account instead`);
    }
  }

  if (data.goodsReceiptId) {
    const receipt = await purchaseRepository.findReceiptById(restaurantId, data.goodsReceiptId);

    if (!receipt) {
      throw new AppError(400, "Selected purchase bill does not exist");
    }

    if (Number(receipt.supplier_id) !== Number(supplier.id)) {
      throw new AppError(400, `${receipt.receipt_number} is ${receipt.supplier_name}'s bill, not ${supplier.name}'s`);
    }

    if (receipt.receipt_status !== "posted") {
      throw new AppError(400, `${receipt.receipt_number} was voided`);
    }
  }
};

// Cash handed over from the drawer belongs to the trading day that is open
// at the till that paid it (a branch with days of its own trades on its own
// day, any other till on the main counter's), so that day's count can allow
// for it. data.tillOutletId is where the person works (null: main counter).
const tillDay = async (restaurantId, data) => {
  if (!data.paidFromTill) {
    return null;
  }

  if (data.paymentMethod !== "cash") {
    throw new AppError(400, "Only cash can come out of the till");
  }

  const day = await openDayOf(restaurantId, data.tillOutletId || null);

  if (!day) {
    throw new AppError(400, "Cash from the till needs an open business day. Open the day first, or record it as paid from the office.");
  }

  return day.business_date;
};

const createPayment = async (restaurantId, data, userId) => {
  requireRestaurantId(restaurantId);

  const supplier = await requireSupplier(restaurantId, data.supplierId);

  await checkPaymentLinks(restaurantId, supplier, data);
  const businessDate = await tillDay(restaurantId, data);

  const written = await purchaseReturnRepository.createPayment(restaurantId, { ...data, businessDate }, userId);

  // The bill was voided while this payment was being entered.
  if (written.error === "BILL_VOID") {
    throw new AppError(400, `${written.receiptNumber || "That bill"} was voided; record the payment against the account instead`);
  }

  const id = written.id;
  const payments = await listPayments(restaurantId, { supplierId: data.supplierId });

  // The list stays the response (what the screen already reads); the new
  // payment is named so a caller does not have to find it in the list.
  return { id, payments };
};

const getPayment = async (restaurantId, id) => {
  const row = await purchaseReturnRepository.findPaymentById(restaurantId, id);

  if (!row) {
    throw new AppError(404, "Payment not found");
  }

  return row;
};

// A payment typed wrong is corrected, with the reason in the activity log
// next to what it was before.
const updatePayment = async (restaurantId, id, data, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await getPayment(restaurantId, id);

  if (existing.payment_status !== "posted") {
    throw new AppError(409, "A voided payment cannot be changed");
  }

  const merged = {
    paymentDate: data.paymentDate || existing.payment_date,
    amount: data.amount ?? Number(existing.amount),
    paymentMethod: data.paymentMethod || existing.payment_method,
    referenceNo: data.referenceNo === undefined ? existing.reference_no : data.referenceNo,
    notes: data.notes === undefined ? existing.notes : data.notes,
    paidFromTill: data.paidFromTill === undefined ? existing.paid_from_till : data.paidFromTill,
  };

  // A till payment keeps the day, and the till, it came out of the drawer at.
  const kept = Boolean(merged.paidFromTill && existing.paid_from_till && existing.business_date);
  merged.tillOutletId = kept ? existing.outlet_id : data.tillOutletId || null;
  const businessDate = merged.paidFromTill
    ? kept
      ? existing.business_date
      : await tillDay(restaurantId, merged)
    : null;

  if (merged.paidFromTill && merged.paymentMethod !== "cash") {
    throw new AppError(400, "Only cash can come out of the till");
  }

  const row = await purchaseReturnRepository.updatePayment(restaurantId, id, { ...merged, businessDate }, userId);

  if (!row) {
    throw new AppError(409, "A voided payment cannot be changed");
  }

  return {
    before: toPayment(existing),
    after: toPayment(await getPayment(restaurantId, id)),
  };
};

const voidPayment = async (restaurantId, id, reason, userId) => {
  requireRestaurantId(restaurantId);

  const existing = await getPayment(restaurantId, id);

  if (existing.payment_status !== "posted") {
    throw new AppError(409, "This payment is already voided");
  }

  const row = await purchaseReturnRepository.voidPayment(restaurantId, id, reason, userId);

  if (!row) {
    throw new AppError(409, "This payment is already voided");
  }

  return toPayment(await getPayment(restaurantId, id));
};

// --- Ageing: which bills are still unpaid, and how late ---

const BUCKETS = [
  { key: "notDue", label: "Not due yet" },
  { key: "days1to30", label: "1–30 days late" },
  { key: "days31to60", label: "31–60 days late" },
  { key: "days61to90", label: "61–90 days late" },
  { key: "days90plus", label: "Over 90 days late" },
];

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);

const bucketFor = (daysLate) => {
  if (daysLate <= 0) return "notDue";
  if (daysLate <= 30) return "days1to30";
  if (daysLate <= 60) return "days31to60";
  if (daysLate <= 90) return "days61to90";
  return "days90plus";
};

// Which bills are still open. A payment or return made against a named bill
// settles that bill first; everything else settles the oldest bills first,
// the way a supplier reads their own ledger. What is left over after every
// bill is settled is an advance.
const openBillsFor = (ledger, supplierId, today) => {
  const mine = (row) => Number(row.supplier_id) === Number(supplierId);
  const bills = ledger.bills
    .filter((bill) => mine(bill) && bill.receipt_status === "posted")
    .map((bill) => ({ ...bill, open: Number(bill.total_amount) }));
  const byId = new Map(bills.map((bill) => [Number(bill.id), bill]));
  let pool = 0;

  const credits = [
    ...ledger.payments.filter((row) => mine(row) && row.payment_status === "posted").map((row) => ({ link: row.goods_receipt_id, value: Number(row.amount) })),
    ...ledger.returns.filter((row) => mine(row) && row.return_status === "posted").map((row) => ({ link: row.goods_receipt_id, value: Number(row.total_amount) })),
  ];

  for (const credit of credits) {
    const bill = credit.link ? byId.get(Number(credit.link)) : null;

    if (bill) {
      const used = Math.min(bill.open, credit.value);
      bill.open = round2(bill.open - used);
      pool = round2(pool + credit.value - used);
    } else {
      pool = round2(pool + credit.value);
    }
  }

  for (const bill of bills) {
    const used = Math.min(bill.open, pool);
    bill.open = round2(bill.open - used);
    pool = round2(pool - used);
  }

  const open = bills
    .filter((bill) => bill.open > 0.004)
    .map((bill) => {
      const due = bill.due_date || bill.bill_date;
      const daysLate = daysBetween(due, today);

      return {
        id: bill.id,
        receiptNumber: bill.receipt_number,
        billNumber: bill.bill_number,
        poNumber: bill.po_number,
        // The store the goods went into (null: the main store).
        outletId: bill.outlet_id === undefined || bill.outlet_id === null ? null : Number(bill.outlet_id),
        billDate: bill.bill_date,
        dueDate: due,
        total: Number(bill.total_amount),
        open: bill.open,
        daysLate: Math.max(daysLate, 0),
        daysToDue: daysLate < 0 ? -daysLate : 0,
        bucket: bucketFor(daysLate),
      };
    });

  const ageing = Object.fromEntries(BUCKETS.map((bucket) => [bucket.key, 0]));

  for (const bill of open) {
    ageing[bill.bucket] = round2(ageing[bill.bucket] + bill.open);
  }

  return { open, ageing, advance: pool };
};

// Purchases received, less returns, less payments made — with how much of it
// is late. The headline "still owed" adds up what is owed to each supplier;
// an advance held by one supplier is shown on its own, never netted against
// another supplier's bill.
const outstanding = async (restaurantId) => {
  requireRestaurantId(restaurantId);

  const [rows, ledger, today, day] = await Promise.all([
    purchaseReturnRepository.outstanding(restaurantId),
    purchaseReturnRepository.findLedger(restaurantId),
    purchaseRepository.findToday(restaurantId),
    businessDayRepository.findOpen(restaurantId),
  ]);
  const tillToday = day
    ? { businessDate: day.business_date, ...(await purchaseReturnRepository.findTillPayments(restaurantId, day.business_date)) }
    : null;

  const suppliers = rows.map((row) => {
    const balance = round2(Number(row.outstanding));
    const { open, ageing } = openBillsFor(ledger, row.id, today);
    const overdue = round2(ageing.days1to30 + ageing.days31to60 + ageing.days61to90 + ageing.days90plus);
    const nextDue = open.filter((bill) => bill.bucket === "notDue").sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];
    const oldestLate = open.filter((bill) => bill.bucket !== "notDue").sort((a, b) => b.daysLate - a.daysLate)[0];

    return {
      supplierId: row.id,
      supplierName: row.name,
      mobile: row.mobile,
      paymentTerms: row.payment_terms,
      creditDays: row.credit_days,
      status: row.status,
      purchased: round2(Number(row.purchased)),
      returned: round2(Number(row.returned)),
      paid: round2(Number(row.paid)),
      // Signed: negative when the supplier holds an advance.
      outstanding: balance,
      owed: balance > 0 ? balance : 0,
      advance: balance < 0 ? -balance : 0,
      overdue,
      ageing,
      openBills: open.length,
      nextDueDate: nextDue ? nextDue.dueDate : null,
      mostDaysLate: oldestLate ? oldestLate.daysLate : 0,
    };
  });

  const sum = (key) => round2(suppliers.reduce((total, row) => total + row[key], 0));

  return {
    today,
    // Cash handed to suppliers from the drawer during the open trading day.
    tillToday,
    buckets: BUCKETS,
    suppliers,
    totals: {
      purchased: sum("purchased"),
      returned: sum("returned"),
      paid: sum("paid"),
      // What the restaurant owes: every supplier it owes money to, added up.
      outstanding: sum("owed"),
      // Money suppliers are holding for the restaurant, shown separately.
      advance: sum("advance"),
      net: sum("outstanding"),
      overdue: sum("overdue"),
      ageing: Object.fromEntries(
        BUCKETS.map((bucket) => [
          bucket.key,
          round2(suppliers.reduce((total, row) => total + row.ageing[bucket.key], 0)),
        ])
      ),
    },
  };
};

// --- Supplier statement ---

// One supplier's account, the way they would send it: every bill, return and
// payment in date order with the balance after each, what was owed before the
// period started, and which bills are still open and how late they are.
// Voided entries are listed (so nothing silently disappears) but move nothing.
const statement = async (restaurantId, { supplierId, from, to }) => {
  requireRestaurantId(restaurantId);

  if (from > to) {
    throw new AppError(400, "The start date is after the end date");
  }

  const supplier = await supplierRepository.findById(restaurantId, supplierId);

  if (!supplier) {
    throw new AppError(404, "Supplier not found");
  }

  const [ledger, today] = await Promise.all([
    purchaseReturnRepository.findLedger(restaurantId, supplierId),
    purchaseRepository.findToday(restaurantId),
  ]);

  const METHOD_WORDS = { cash: "Cash", card: "Card", upi: "UPI", bank: "Bank transfer", cheque: "Cheque", other: "Other" };

  const entries = [
    ...ledger.bills.map((bill) => ({
      date: bill.bill_date,
      type: "bill",
      id: bill.id,
      number: bill.receipt_number,
      reference: [bill.bill_number ? `Bill ${bill.bill_number}` : null, bill.po_number].filter(Boolean).join(" · "),
      dueDate: bill.receipt_status === "posted" && bill.payment_mode === "credit" ? bill.due_date : null,
      amount: Number(bill.total_amount),
      effect: bill.receipt_status === "posted" ? Number(bill.total_amount) : 0,
      status: bill.receipt_status,
      voidReason: bill.void_reason,
      order: 0,
      createdAt: bill.created_at,
    })),
    ...ledger.returns.map((ret) => ({
      date: ret.return_date,
      type: "return",
      id: ret.id,
      number: ret.return_number,
      reference: ret.reason,
      dueDate: null,
      amount: Number(ret.total_amount),
      effect: ret.return_status === "posted" ? -Number(ret.total_amount) : 0,
      status: ret.return_status,
      voidReason: ret.void_reason,
      order: 1,
      createdAt: ret.created_at,
    })),
    ...ledger.payments.map((payment) => ({
      date: payment.payment_date,
      type: "payment",
      id: payment.id,
      number: `PAY-${String(payment.id).padStart(4, "0")}`,
      reference: [
        METHOD_WORDS[payment.payment_method] || payment.payment_method,
        payment.paid_from_till ? "from the till" : null,
        payment.reference_no,
      ]
        .filter(Boolean)
        .join(" · "),
      dueDate: null,
      amount: Number(payment.amount),
      effect: payment.payment_status === "posted" ? -Number(payment.amount) : 0,
      status: payment.payment_status,
      voidReason: payment.void_reason,
      order: 2,
      createdAt: payment.created_at,
    })),
  ].sort(
    (a, b) =>
      (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
      a.order - b.order ||
      new Date(a.createdAt) - new Date(b.createdAt)
  );

  const openingBalance = round2(
    entries.filter((entry) => entry.date < from).reduce((sum, entry) => sum + entry.effect, 0)
  );

  let balance = openingBalance;
  const inPeriod = entries
    .filter((entry) => entry.date >= from && entry.date <= to)
    .map((entry) => {
      balance = round2(balance + entry.effect);

      return {
        date: entry.date,
        type: entry.type,
        id: entry.id,
        number: entry.number,
        reference: entry.reference,
        dueDate: entry.dueDate,
        // Bills add to what is owed; returns and payments take it down.
        billed: entry.type === "bill" ? entry.amount : 0,
        settled: entry.type === "bill" ? 0 : entry.amount,
        status: entry.status,
        voidReason: entry.voidReason,
        balance,
      };
    });

  const { open, ageing, advance } = openBillsFor(ledger, supplierId, today);

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
      gstNumber: supplier.gst_number,
      mobile: supplier.mobile,
      address: supplier.address,
      paymentTerms: supplier.payment_terms,
      creditDays: supplier.credit_days,
    },
    from,
    to,
    today,
    openingBalance,
    entries: inPeriod,
    totals: {
      billed: round2(inPeriod.filter((e) => e.status !== "void").reduce((sum, e) => sum + e.billed, 0)),
      settled: round2(inPeriod.filter((e) => e.status !== "void").reduce((sum, e) => sum + e.settled, 0)),
    },
    closingBalance: balance,
    openBills: open,
    ageing,
    advance,
    buckets: BUCKETS,
  };
};

// What the day-end cash count should allow for: cash paid to suppliers out of
// the drawer on that trading day, { count, amount }. For the day-end report,
// which subtracts it from the cash the drawer should hold.
const tillPaymentsForDay = async (restaurantId, businessDate) => {
  requireRestaurantId(restaurantId);

  return purchaseReturnRepository.findTillPayments(restaurantId, businessDate);
};

module.exports = {
  openBillsFor,
  list,
  getById,
  creditLimit,
  create,
  update,
  voidReturn,
  tillPaymentsForDay,
  listPayments,
  createPayment,
  updatePayment,
  voidPayment,
  outstanding,
  statement,
};
