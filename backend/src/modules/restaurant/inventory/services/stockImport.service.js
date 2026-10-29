const pool = require("../../../../config/database");
const inventoryRepository = require("../repositories/inventory.repository");
const { pinnedStore } = require("./inventory.service");
const AppError = require("../../../../utils/AppError");
const { round2 } = require("../../../../utils/money");
const { MAX_AMOUNT, MAX_QUANTITY } = require("../../../../utils/amountLimit");
const sheet = require("../../../../utils/sheetImport");

// Stock items from a spreadsheet: how a restaurant moving
// from Petpooja or a paper register loads 300 items, their packs and what is
// on the shelf today, in one go. The rules are sheetImport's (a check first,
// only the file's columns change, all or nothing, the same file twice changes
// nothing). And:
//
//   * An item is found by its code, then by its name. Found items are
//     updated, the rest are added.
//   * Opening stock is posted as an "opening" movement at the cost given,
//     dated the day the file says (or today), so the item's average cost
//     starts right. It is only ever posted for an item with no stock history:
//     a second run, or an item already in use, is told so and left alone —
//     stock already on the books is corrected with a count, not an import.
//   * Units must be ones the restaurant has set up (kg, L, pc…). Common ways
//     of writing them (kgs, ltr, nos, pcs) are understood; anything else is
//     a problem, never a new unit made up from a typo.
//   * An item's unit is fixed once a movement, recipe or order has used it.

const COLUMNS = [
  { key: "name", label: "Item name", need: "new", aliases: ["name", "itemname", "item", "material", "rawmaterial", "ingredient", "stockitem", "itemdescription"], help: "The item as the store calls it. Finds an existing item when there is no code.", example: "Paneer" },
  { key: "code", label: "Code", need: "optional", aliases: ["code", "itemcode", "sku", "shortcode"], help: "Your own code, such as DAI-01. Finds the item first, even after a rename.", example: "DAI-01" },
  { key: "unit", label: "Unit", need: "new", aliases: ["unit", "uom", "unitofmeasure", "measure", "units"], help: "The unit stock, recipes and counts use: kg, g, L, ml, pc. Must be set up under Units.", example: "kg" },
  { key: "category", label: "Category", need: "optional", aliases: ["category", "group", "itemgroup", "itemcategory"], help: "Dairy, Vegetables, Packaging…", example: "Dairy" },
  { key: "storageArea", label: "Storage area", need: "optional", aliases: ["storagearea", "storage", "storagelocation", "location", "area", "rack"], help: "Where it lives, so count sheets follow the walk: Walk-in cooler, Dry store.", example: "Walk-in cooler" },
  { key: "reorderLevel", label: "Reorder level", need: "optional", aliases: ["reorderlevel", "reorder", "reorderat", "minstock", "minimumstock", "minimum", "parlevel", "minlevel"], help: "Warn when stock falls to this much (in the item's unit).", example: "5" },
  { key: "itemType", label: "Type", need: "optional", aliases: ["type", "itemtype", "kind"], help: "Raw (bought) or Prepared (made in the kitchen: gravies, doughs).", example: "Raw" },
  { key: "packs", label: "Packs", need: "optional", aliases: ["packs", "pack", "packsizes", "packsize", "packing"], help: "How it is bought, in the item's unit: Tin=15; Tray=30. Packs not listed are removed.", example: "Block=1" },
  { key: "openingQuantity", label: "Opening stock", need: "optional", aliases: ["openingstock", "openingquantity", "openingqty", "opening", "stock", "quantity", "qty", "currentstock", "stockinhand", "closingstock"], help: "What is on the shelf today, in the item's unit. Only for an item with no stock history yet.", example: "12.5" },
  { key: "openingCost", label: "Cost per unit", need: "optional", aliases: ["openingcost", "cost", "costperunit", "unitcost", "rate", "purchaseprice", "purchaserate", "price"], help: "What one unit cost, for the opening stock's value and the item's average cost.", example: "320" },
  { key: "batch", label: "Batch", need: "optional", aliases: ["batch", "batchnumber", "batchno", "lot", "lotnumber", "lotno"], help: "Batch or lot number of the opening stock.", example: "PNR-0930" },
  { key: "expiry", label: "Expiry", need: "optional", aliases: ["expiry", "expirydate", "bestbefore", "useby", "usebydate", "expdate"], help: "Expiry date of the opening stock: 25-10-2026.", example: "10-10-2026" },
  { key: "stockDate", label: "As on", need: "optional", aliases: ["asondate", "ason", "openingdate", "stockdate", "date", "countedon"], help: "The day the opening stock was counted. Empty is today.", example: "" },
  { key: "store", label: "Store", need: "optional", aliases: ["store", "outlet", "branch", "storename", "outletname"], help: "Main store, or an outlet that keeps its own stock: where the opening stock is.", example: "Main store" },
  { key: "status", label: "Status", need: "optional", aliases: ["status", "active"], help: "active or inactive.", example: "active" },
];

// Ways people write a unit, folded into one family each.
const UNIT_FAMILIES = [
  ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms"],
  ["g", "gm", "gms", "gram", "grams", "gr", "grm"],
  ["l", "lt", "ltr", "ltrs", "litre", "litres", "liter", "liters"],
  ["ml", "mls", "millilitre", "millilitres", "milliliter", "milliliters"],
  ["pc", "pcs", "piece", "pieces", "nos", "no", "number", "numbers", "unit", "units", "each", "ea"],
  ["dozen", "dz", "doz"],
  ["box", "boxes"],
  ["pkt", "pkts", "packet", "packets"],
  ["bottle", "bottles", "btl", "btls"],
  ["tin", "tins", "can", "cans"],
  ["tray", "trays"],
  ["bunch", "bunches"],
];

const familyOf = (word) => UNIT_FAMILIES.find((family) => family.includes(word)) || [word];

const findUnit = (units, text) => {
  const typed = sheet.normalise(text);

  if (!typed) {
    return null;
  }

  const exact = units.find((unit) => sheet.normalise(unit.short_name) === typed || sheet.normalise(unit.name) === typed);

  if (exact) {
    return exact;
  }

  const family = familyOf(typed);

  return units.find((unit) => family.includes(sheet.normalise(unit.short_name)) || family.includes(sheet.normalise(unit.name))) || null;
};

const parsePacks = (text) => {
  const packs = [];

  for (const part of String(text).split(/[;|]/).map((entry) => entry.trim()).filter(Boolean)) {
    const match = /^(.+?)\s*[=:]\s*([\d.,]+)\s*[a-z]*$/i.exec(part);

    if (!match) {
      return { error: `"${part}" should be written like Tin=15` };
    }

    const size = Number(match[2].replace(/,/g, ""));

    if (!(size > 0) || size > MAX_QUANTITY) {
      return { error: `The ${match[1]} pack size "${match[2]}" must be more than 0` };
    }

    const name = match[1].trim().slice(0, 40);

    if (packs.some((pack) => pack.name.toLowerCase() === name.toLowerCase())) {
      return { error: `The pack "${name}" is listed twice` };
    }

    packs.push({ name, size });
  }

  return { value: packs };
};

const packsText = (packs) =>
  packs.length ? [...packs].sort((a, b) => a.name.localeCompare(b.name)).map((pack) => `${pack.name}=${Number(pack.size)}`).join("; ") : "none";

const TYPE_WORDS = { raw: "raw", purchased: "raw", bought: "raw", prepared: "prepared", subrecipe: "prepared", semifinished: "prepared", made: "prepared" };

const loadContext = async (restaurantId, pinnedOutletId) => {
  const [units, items, packs, history, outlets, settings] = await Promise.all([
    pool.query("SELECT id, name, short_name, status FROM units WHERE restaurant_id = $1", [restaurantId]),
    pool.query(
      `SELECT i.id, i.name, i.code, i.unit_id, i.category, i.storage_area, i.reorder_level, i.item_type, i.status,
              u.short_name AS unit_short_name
       FROM inventory_items i JOIN units u ON u.id = i.unit_id
       WHERE i.restaurant_id = $1`,
      [restaurantId]
    ),
    pool.query(
      `SELECT p.id, p.inventory_item_id, p.name, p.size FROM inventory_item_packs p
       WHERE p.restaurant_id = $1 ORDER BY p.id`,
      [restaurantId]
    ),
    // Items with any stock history, and items a recipe or an order uses (their
    // unit is then fixed).
    pool.query(
      `SELECT i.id,
              EXISTS (SELECT 1 FROM stock_transactions st WHERE st.inventory_item_id = i.id) AS has_stock,
              (EXISTS (SELECT 1 FROM stock_transactions st WHERE st.inventory_item_id = i.id)
               OR EXISTS (SELECT 1 FROM product_recipes r WHERE r.inventory_item_id = i.id)
               OR EXISTS (SELECT 1 FROM purchase_order_items poi WHERE poi.inventory_item_id = i.id)) AS in_use
       FROM inventory_items i WHERE i.restaurant_id = $1`,
      [restaurantId]
    ),
    pool.query("SELECT id, name, status, own_store FROM outlets WHERE restaurant_id = $1", [restaurantId]),
    pool.query("SELECT timezone FROM restaurant_settings WHERE restaurant_id = $1", [restaurantId]),
  ]);

  const packsOf = new Map();

  for (const pack of packs.rows) {
    const list = packsOf.get(Number(pack.inventory_item_id)) || [];
    list.push({ id: Number(pack.id), name: pack.name, size: Number(pack.size) });
    packsOf.set(Number(pack.inventory_item_id), list);
  }

  const usage = new Map(history.rows.map((row) => [Number(row.id), row]));
  const timezone = (settings.rows[0] && settings.rows[0].timezone) || "Asia/Kolkata";

  return {
    units: units.rows.filter((unit) => unit.status === "active"),
    allUnits: units.rows,
    items: items.rows.map((row) => ({ ...row, id: Number(row.id), packs: packsOf.get(Number(row.id)) || [], usage: usage.get(Number(row.id)) })),
    outlets: outlets.rows,
    pinned: await pinnedStore(restaurantId, pinnedOutletId),
    today: new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date()),
    timezone,
  };
};

const FIELD_LABELS = {
  name: "Name",
  code: "Code",
  unit: "Unit",
  category: "Category",
  storageArea: "Storage area",
  reorderLevel: "Reorder level",
  itemType: "Type",
  packs: "Packs",
  status: "Status",
};

const plan = (rawRows, context) => {
  const columns = sheet.resolveColumns(rawRows, COLUMNS);
  const problems = [];
  const rows = [];
  const seenNames = new Map();
  const seenCodes = new Map();
  const byCode = new Map(context.items.filter((item) => item.code).map((item) => [item.code.toUpperCase(), item]));
  const byName = new Map(context.items.map((item) => [item.name.toLowerCase(), item]));

  if (!columns.byKey.name && !columns.byKey.code) {
    problems.push({ line: 1, column: "name", message: "The file needs an Item name column (or a Code column to find existing items)" });
  }

  rawRows.forEach((raw, index) => {
    const line = index + 2;
    const cells = sheet.cellsOf(raw, columns.byKey);
    const given = (key) => columns.byKey[key] && cells[key] !== "";
    const problem = (column, message) => problems.push({ line, column, message });
    const before = problems.length;

    // Which item this row is.
    const code = given("code") ? cells.code.toUpperCase().slice(0, 30) : null;
    const name = given("name") ? cells.name.replace(/\s+/g, " ").slice(0, 150) : null;
    let existing = code ? byCode.get(code) || null : null;

    if (!existing && name) {
      existing = byName.get(name.toLowerCase()) || null;
    }

    if (!existing && !name) {
      problem("name", code ? `No item has the code ${code}, and the row has no name to add it with` : "The row has no item name");
      return;
    }

    const key = existing ? `item:${existing.id}` : `new:${name.toLowerCase()}`;

    if (seenNames.has(key)) {
      problem("name", `The same item is on row ${seenNames.get(key)} too`);
      return;
    }

    seenNames.set(key, line);

    if (code) {
      if (seenCodes.has(code)) {
        problem("code", `The code ${code} is on row ${seenCodes.get(code)} too`);
      }

      seenCodes.set(code, line);
      const owner = byCode.get(code);

      if (owner && existing && owner.id !== existing.id) {
        problem("code", `The code ${code} already belongs to ${owner.name}`);
      }
    }

    if (existing && name && name.toLowerCase() !== existing.name.toLowerCase()) {
      const clash = byName.get(name.toLowerCase());

      if (clash && clash.id !== existing.id) {
        problem("name", `Another item is already called ${clash.name}`);
      }
    }

    const fields = {};
    const changes = [];
    const notes = [];
    const change = (field, from, to) => changes.push({ field, label: FIELD_LABELS[field] || field, from, to });

    if (existing && name && name !== existing.name) {
      fields.name = name;
      change("name", existing.name, name);
    }

    if (code && (!existing || code !== (existing.code || "").toUpperCase())) {
      fields.code = code;

      if (existing) {
        change("code", existing.code || "—", code);
      }
    }

    // Unit
    let unit = existing ? context.allUnits.find((row) => Number(row.id) === Number(existing.unit_id)) : null;

    if (given("unit")) {
      const found = findUnit(context.units, cells.unit);

      if (!found) {
        problem(
          "unit",
          `"${cells.unit}" is not one of your units (${context.units.map((row) => row.short_name).join(", ") || "none set up yet"}). Add it under Items & stock → Units first.`
        );
      } else if (existing && Number(found.id) !== Number(existing.unit_id)) {
        if (existing.usage && existing.usage.in_use) {
          problem("unit", `${existing.name} is already measured in ${existing.unit_short_name} (stock, recipes or orders use it), so its unit cannot change`);
        } else {
          fields.unit_id = Number(found.id);
          change("unit", existing.unit_short_name, found.short_name);
          unit = found;
        }
      } else {
        unit = found;

        if (!existing) {
          fields.unit_id = Number(found.id);
        }
      }
    } else if (!existing) {
      problem("unit", "A new item needs its unit (kg, L, pc…)");
    }

    const text = (key, column, max) => {
      if (!given(key)) {
        return;
      }

      const value = cells[key].slice(0, max);

      if (!existing || (existing[column] || "") !== value) {
        fields[column] = value;

        if (existing) {
          change(key, existing[column] || "—", value);
        }
      }
    };

    text("category", "category", 50);
    text("storageArea", "storage_area", 50);

    if (given("reorderLevel")) {
      const parsed = sheet.parseNumber(cells.reorderLevel, { max: MAX_QUANTITY });

      if (parsed.error) {
        problem("reorderLevel", parsed.error);
      } else if (!existing || Number(existing.reorder_level) !== parsed.value) {
        fields.reorder_level = parsed.value;

        if (existing) {
          change("reorderLevel", Number(existing.reorder_level), parsed.value);
        }
      }
    }

    if (given("itemType")) {
      const type = TYPE_WORDS[sheet.normalise(cells.itemType)];

      if (!type) {
        problem("itemType", `"${cells.itemType}" should be Raw or Prepared`);
      } else if (!existing || existing.item_type !== type) {
        fields.item_type = type;

        if (existing) {
          change("itemType", existing.item_type, type);
        }
      }
    }

    if (given("status")) {
      const yes = sheet.parseYesNo(cells.status);

      if (yes.error) {
        problem("status", `"${cells.status}" should be active or inactive`);
      } else {
        const status = yes.value ? "active" : "inactive";

        if (!existing || existing.status !== status) {
          fields.status = status;

          if (existing) {
            change("status", existing.status, status);
          }
        }
      }
    }

    let packs = null;

    if (given("packs")) {
      const parsed = sheet.normalise(cells.packs) === "none" ? { value: [] } : parsePacks(cells.packs);

      if (parsed.error) {
        problem("packs", parsed.error);
      } else if (!existing || packsText(existing.packs) !== packsText(parsed.value)) {
        packs = parsed.value.map((pack) => {
          const same = existing ? existing.packs.find((old) => old.name.toLowerCase() === pack.name.toLowerCase()) : null;
          return same ? { ...pack, id: same.id } : pack;
        });

        if (existing) {
          change("packs", packsText(existing.packs), packsText(parsed.value));
        }
      }
    }

    // Opening stock: posted once, for an item with no stock history.
    let opening = null;

    if (given("openingQuantity")) {
      const quantity = sheet.parseNumber(cells.openingQuantity, { max: MAX_QUANTITY });
      const cost = given("openingCost") ? sheet.parseNumber(cells.openingCost, { max: 9999999, what: "a price" }) : { value: null };
      const date = given("stockDate") ? sheet.parseDate(cells.stockDate, { minYear: 2000 }) : { value: context.today };
      const expiry = given("expiry") ? sheet.parseDate(cells.expiry, { minYear: 2000 }) : { value: null };

      if (quantity.error) {
        problem("openingQuantity", quantity.error);
      }

      if (cost.error) {
        problem("openingCost", cost.error);
      }

      if (date.error) {
        problem("stockDate", date.error);
      } else if (date.value > context.today) {
        problem("stockDate", "Opening stock cannot be dated in the future");
      }

      if (expiry.error) {
        problem("expiry", expiry.error);
      }

      // Where the stock is: the store named, else the main store — or, for
      // someone tied to one outlet, theirs (and only theirs).
      let storeId = context.pinned ? context.pinned.storeId : null;
      let storeName = context.pinned ? context.pinned.name : "Main store";

      if (given("store")) {
        const wanted = cells.store.toLowerCase();
        const outlet = ["main", "mainstore", "main store", "central", "central store"].includes(wanted)
          ? null
          : context.outlets.find((row) => row.name.toLowerCase() === wanted);

        if (outlet === undefined) {
          problem("store", `"${cells.store}" is not one of your outlets. Write Main store or an outlet's name.`);
        } else if (outlet && !outlet.own_store) {
          problem("store", `${outlet.name} sells from the main store and keeps no stock of its own`);
        } else if (outlet && outlet.status !== "active") {
          problem("store", `${outlet.name} is not active`);
        } else {
          storeId = outlet ? Number(outlet.id) : null;
          storeName = outlet ? outlet.name : "Main store";
        }
      }

      if (context.pinned && storeId !== context.pinned.storeId) {
        problem("store", `You are set up to work at one outlet only, so opening stock can go into ${context.pinned.name} only`);
      }

      if (!quantity.error && !cost.error && quantity.value > 0) {
        if (cost.value !== null && quantity.value * cost.value > MAX_AMOUNT) {
          problem("openingQuantity", `${quantity.value} × ${cost.value} comes to more than one item's stock can be worth. Check the quantity and the cost.`);
        } else if (existing && existing.usage && existing.usage.has_stock) {
          notes.push(`${existing.name} already has stock on the books, so its opening stock is not added again. Correct it with a stock count.`);
        } else {
          opening = {
            quantity: quantity.value,
            cost: cost.value,
            date: date.value,
            expiry: expiry.value,
            batch: given("batch") ? cells.batch.slice(0, 100) : null,
            storeId,
            storeName,
          };

          if (cost.value === null) {
            notes.push("No cost given: the opening stock has no value until the first purchase bill sets one.");
          }
        }
      }
    } else if (given("openingCost") || given("batch") || given("expiry")) {
      notes.push("Cost, batch and expiry only count with an opening stock quantity.");
    }

    if (problems.length > before) {
      return;
    }

    const action = !existing ? "create" : changes.length > 0 || opening ? "update" : "unchanged";

    rows.push({
      line,
      key,
      name: (existing && fields.name) || (existing ? existing.name : name),
      action,
      changes,
      notes,
      ...(opening ? { opening: { quantity: opening.quantity, cost: opening.cost, store: opening.storeName, date: opening.date } } : {}),
      details: !existing
        ? {
            unit: unit ? unit.short_name : null,
            category: fields.category || null,
            reorderLevel: fields.reorder_level ?? 0,
            packs: packs ? packsText(packs) : null,
          }
        : undefined,
      // What was matched, as it stood: a record that moves before the import
      // gives another fingerprint.
      state: existing ? [existing.name, existing.code, existing.unit_id, existing.category, existing.storage_area, String(existing.reorder_level), existing.item_type, existing.status, packsText(existing.packs), Boolean(existing.usage && existing.usage.has_stock)] : null,
      write: { existingId: existing ? existing.id : null, fields, packs, opening, name: name || (existing && existing.name) },
    });
  });

  return {
    columns,
    problems,
    rows,
    extra: {
      opening: {
        items: rows.filter((row) => row.opening).length,
        value: round2(rows.filter((row) => row.opening && row.opening.cost !== null).reduce((sum, row) => sum + row.opening.quantity * row.opening.cost, 0)),
      },
    },
  };
};

const COLUMN_SQL = ["name", "code", "unit_id", "category", "storage_area", "reorder_level", "item_type", "status"];

const apply = async (restaurantId, planned, userId, context) => {
  const client = await pool.connect();
  const created = [];

  try {
    await client.query("BEGIN");
    // One import at a time per restaurant, so two people loading files at
    // once cannot both add the same item.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`stock-import:${restaurantId}`]);

    for (const row of planned.rows) {
      if (row.action === "unchanged") {
        continue;
      }

      const { existingId, fields, packs, opening } = row.write;
      let itemId = existingId;

      if (!existingId) {
        const inserted = await client.query(
          `INSERT INTO inventory_items (restaurant_id, name, code, unit_id, category, storage_area, reorder_level,
                                        item_type, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
           RETURNING id`,
          [
            restaurantId,
            row.write.name,
            fields.code || null,
            fields.unit_id,
            fields.category || null,
            fields.storage_area || null,
            fields.reorder_level ?? 0,
            fields.item_type || "raw",
            fields.status || "active",
            userId,
          ]
        );
        itemId = Number(inserted.rows[0].id);
        created.push({ line: row.line, id: itemId, name: row.write.name });
      } else {
        const keys = COLUMN_SQL.filter((column) => fields[column] !== undefined);

        if (keys.length > 0) {
          await client.query(
            `UPDATE inventory_items SET ${keys.map((column, at) => `${column} = $${at + 3}`).join(", ")}, updated_by = $${keys.length + 3}
             WHERE restaurant_id = $1 AND id = $2`,
            [restaurantId, existingId, ...keys.map((column) => fields[column]), userId]
          );
        }
      }

      if (packs) {
        const keep = packs.filter((pack) => pack.id).map((pack) => pack.id);

        await client.query(
          "DELETE FROM inventory_item_packs WHERE restaurant_id = $1 AND inventory_item_id = $2 AND NOT (id = ANY($3::bigint[]))",
          [restaurantId, itemId, keep]
        );

        for (const pack of packs) {
          if (pack.id) {
            await client.query(
              "UPDATE inventory_item_packs SET name = $3, size = $4, updated_by = $5 WHERE inventory_item_id = $1 AND id = $2",
              [itemId, pack.id, pack.name, pack.size, userId]
            );
          } else {
            await client.query(
              `INSERT INTO inventory_item_packs (restaurant_id, inventory_item_id, name, size, created_by, updated_by)
               VALUES ($1, $2, $3, $4, $5, $5)`,
              [restaurantId, itemId, pack.name, pack.size, userId]
            );
          }
        }
      }

      if (opening) {
        const moment = await client.query("SELECT ($1::date::timestamp AT TIME ZONE $2::text) AS at", [opening.date, context.timezone]);

        await inventoryRepository.recordMovement(
          client,
          restaurantId,
          {
            inventoryItemId: itemId,
            outletId: opening.storeId,
            transactionType: "opening",
            quantity: opening.quantity,
            unitCost: opening.cost,
            reason: "Opening stock (import)",
            batchNumber: opening.batch,
            expiryDate: opening.expiry,
            effectiveAt: opening.date === context.today ? null : moment.rows[0].at,
          },
          userId
        );
      }
    }

    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");

    if (error.code === "23505") {
      throw sheet.staleError();
    }

    throw error;
  } finally {
    client.release();
  }
};

const importGuide = () =>
  sheet.guideOf(COLUMNS, {
    columns: ["Item name", "Code", "Unit", "Category", "Storage area", "Reorder level", "Packs", "Opening stock", "Cost per unit", "Batch", "Expiry"],
    rows: [
      ["Paneer", "DAI-01", "kg", "Dairy", "Walk-in cooler", "5", "Block=1", "12", "320", "PNR-0930", "10-10-2026"],
      ["Refined oil", "OIL-01", "L", "Oils", "Dry store", "15", "Tin=15", "30", "143.33", "", ""],
      ["Basmati rice", "GRN-01", "kg", "Grains", "Dry store", "25", "Bag=25", "50", "112", "", ""],
      ["Eggs", "EGG-01", "pc", "Dairy", "Walk-in cooler", "60", "Tray=30", "90", "6.5", "", ""],
    ],
  });

// rows: the sheet as heading -> cell. options: { dryRun, fingerprint,
// pinnedOutletId }.
const importItems = async (restaurantId, rows, userId, options = {}) => {
  if (!restaurantId) {
    throw new AppError(400, "This account is not linked to a restaurant");
  }

  sheet.checkRows(rows);

  const context = await loadContext(restaurantId, options.pinnedOutletId || null);
  const planned = plan(rows, context);
  const summary = sheet.summarise(planned, planned.columns);

  if (!summary.ok || options.dryRun) {
    return summary;
  }

  if (options.fingerprint && options.fingerprint !== summary.fingerprint) {
    throw sheet.staleError();
  }

  const created = await apply(restaurantId, planned, userId, context);

  return { ...summary, createdItems: created };
};

module.exports = { importGuide, importItems };
