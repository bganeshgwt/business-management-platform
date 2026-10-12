-- Up Migration

-- The back-of-house repair: the weekly stock count, purchase bills that do not
-- need a purchase order, supplier ledgers that can be corrected, per-size
-- recipes, packs a supplier sells in, and stock that stays in the store it is
-- actually in.

-- === Which outlets keep their own stock ===
-- Until now a sale at any outlet came out of the main store, while transfers
-- put stock on the outlet's own shelf — so outlet stock only ever went up. An
-- outlet either runs its own store (it receives transfers or deliveries and
-- its sales come off its own shelf) or it draws on the main store, like a
-- takeaway counter in the same building. That is a fact about the outlet, not
-- about each movement, so it lives here.
ALTER TABLE outlets
  ADD COLUMN own_store BOOLEAN NOT NULL DEFAULT FALSE;

-- An outlet already holding stock has been run as its own store.
UPDATE outlets o
SET own_store = TRUE
WHERE EXISTS (
  SELECT 1 FROM stock_balances sb
  WHERE sb.outlet_id = o.id AND sb.quantity <> 0
);

-- === Per-unit costs to eight decimals ===
-- A tin of oil at Rs 2,150 is 15,000 ml, which is Rs 0.143333... a
-- millilitre. Kept to two decimals that becomes Rs 0.14 and every recipe
-- using oil is under-costed by 2%. Even four decimals (0.1433) makes the tin
-- worth Rs 2,149.50 in the ledger — 50 paise away from the bill that paid
-- for it. At eight decimals, quantity x cost comes back to the rupee and
-- paisa that was paid for any realistic delivery. Money totals stay at two
-- decimals; only per-unit costs carry the extra precision.
ALTER TABLE inventory_items ALTER COLUMN last_cost TYPE NUMERIC(18,8);
ALTER TABLE stock_transactions ALTER COLUMN unit_cost TYPE NUMERIC(18,8);
ALTER TABLE purchase_order_items ALTER COLUMN unit_price TYPE NUMERIC(18,8);
ALTER TABLE purchase_return_items ALTER COLUMN unit_price TYPE NUMERIC(18,8);

-- === When stock really moved ===
-- A delivery is often entered days after it arrived (the bill turns up with
-- the next delivery, the storekeeper was off). created_at says when it was
-- typed in; effective_at says when the goods were actually on the shelf. The
-- closing stock on a date and what a count expected go by effective_at, so a
-- bill typed in late still counts on the day the goods came in. For
-- everything recorded as it happens the two are the same moment.
ALTER TABLE stock_transactions
  ADD COLUMN effective_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE stock_transactions SET effective_at = created_at;

CREATE INDEX idx_stock_transactions_effective
  ON stock_transactions (inventory_item_id, effective_at);

-- The stock movements list filters the whole restaurant's ledger by date,
-- and those dates are when the goods came in: "what arrived on the 22nd"
-- finds a bill typed in on the 25th.
CREATE INDEX idx_stock_transactions_restaurant_effective
  ON stock_transactions (restaurant_id, effective_at DESC);

-- === Document numbers that are never handed out twice ===
-- PO-0007, GRN-0012, PR-0003, SC-0005. Numbering from the documents that
-- exist gave the number of a deleted draft to the next order — and a draft
-- may already have gone to the supplier on WhatsApp. Each series keeps the
-- last number it handed out, and only ever counts up.
-- The preceding billing migration creates the shared counter table.

INSERT INTO document_counters (restaurant_id, series, last_number)
SELECT restaurant_id, 'PO', MAX(SUBSTRING(po_number FROM '^PO-([0-9]+)$')::int)
FROM purchase_orders
WHERE po_number ~ '^PO-[0-9]+$'
GROUP BY restaurant_id;

INSERT INTO document_counters (restaurant_id, series, last_number)
SELECT restaurant_id, 'PR', MAX(SUBSTRING(return_number FROM '^PR-([0-9]+)$')::int)
FROM purchase_returns
WHERE return_number ~ '^PR-[0-9]+$'
GROUP BY restaurant_id;

-- Which movements set the item's cost. Only stock coming IN at a price does:
-- a delivery, opening stock, a hand-entered stock-in. A return to the
-- supplier, a count correction or a voided bill carries a value for the record
-- but must never re-price the item, which is how one mistyped return used to
-- change the food cost of every dish using it. Stored per row, so "what was
-- this worth on the 31st" can be answered from the ledger.
ALTER TABLE stock_transactions
  ADD COLUMN sets_cost BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE stock_transactions
SET sets_cost = TRUE
WHERE quantity > 0 AND unit_cost IS NOT NULL;

CREATE INDEX idx_stock_transactions_cost
  ON stock_transactions (inventory_item_id, effective_at DESC)
  WHERE sets_cost;

-- Before this, a return's credit price became the item's cost. Where that
-- happened and nothing has been bought since, the item still carries the
-- typo (Rs 99,999 a kg), and every recipe and the stock value with it. Those
-- items go back to the price of the last delivery or stock-in before the
-- return; an item that has never been bought at a price has no cost at all.
WITH priced AS (
  SELECT DISTINCT ON (st.inventory_item_id) st.inventory_item_id, st.unit_cost, st.created_at
  FROM stock_transactions st
  WHERE st.sets_cost
  ORDER BY st.inventory_item_id, st.created_at DESC, st.id DESC
)
UPDATE inventory_items i
SET last_cost = priced.unit_cost
FROM priced
WHERE priced.inventory_item_id = i.id
  AND i.last_cost IS DISTINCT FROM priced.unit_cost
  AND EXISTS (
    SELECT 1 FROM stock_transactions r
    WHERE r.inventory_item_id = i.id
      AND (r.transaction_type = 'return' OR r.reference_type = 'purchase_return')
      AND r.unit_cost = i.last_cost AND r.created_at > priced.created_at
  );

UPDATE inventory_items i
SET last_cost = NULL
WHERE i.last_cost IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM stock_transactions st WHERE st.inventory_item_id = i.id AND st.sets_cost)
  AND EXISTS (
    SELECT 1 FROM stock_transactions r
    WHERE r.inventory_item_id = i.id AND r.unit_cost = i.last_cost
      AND (r.transaction_type = 'return' OR r.reference_type = 'purchase_return')
  );

-- Returns now have their own movement type (added earlier) and count
-- corrections point back at their count sheet; both are looked up by reference.
CREATE INDEX idx_stock_transactions_reference
  ON stock_transactions (reference_type, reference_id)
  WHERE reference_id IS NOT NULL;

-- Where an item lives, so a count sheet can follow the walk through the
-- store: walk-in cooler, dry store, freezer, bar.
ALTER TABLE inventory_items
  ADD COLUMN storage_area VARCHAR(50);

-- === Packs: the unit a supplier sells in ===
-- Stock and recipes stay in the item's own unit (ml, piece, kg). A supplier
-- sells oil by the 15-litre tin, eggs by the tray of 30, tomatoes by the
-- 25 kg crate. A pack says how many of the item's units one of them holds, so
-- nobody does that arithmetic at the back door.
CREATE TABLE inventory_item_packs (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id     BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  inventory_item_id BIGINT        NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  name              VARCHAR(40)   NOT NULL,
  -- How many of the item's own units one pack holds: 15000 (ml) in a tin.
  size              NUMERIC(14,4) NOT NULL CHECK (size > 0),
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by        BIGINT        REFERENCES users(id),
  updated_by        BIGINT        REFERENCES users(id)
);

CREATE UNIQUE INDEX uq_inventory_item_packs_name
  ON inventory_item_packs (inventory_item_id, LOWER(name));
CREATE INDEX idx_inventory_item_packs_restaurant ON inventory_item_packs (restaurant_id);

CREATE TRIGGER trg_inventory_item_packs_updated_at
BEFORE UPDATE ON inventory_item_packs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A purchase order line may be ordered in packs. The pack's name and size are
-- copied onto the line, so editing or deleting the pack later cannot change
-- what was ordered. quantity and unit_price stay in the item's own unit, so
-- everything that already reads them keeps working.
ALTER TABLE purchase_order_items
  ADD COLUMN pack_id       BIGINT        REFERENCES inventory_item_packs(id) ON DELETE SET NULL,
  ADD COLUMN pack_name     VARCHAR(40),
  ADD COLUMN pack_size     NUMERIC(14,4) CHECK (pack_size IS NULL OR pack_size > 0),
  ADD COLUMN pack_quantity NUMERIC(14,3) CHECK (pack_quantity IS NULL OR pack_quantity > 0),
  ADD COLUMN pack_price    NUMERIC(14,2) CHECK (pack_price IS NULL OR pack_price >= 0);

-- === Purchase orders that end short ===
-- A supplier who delivers 8 kg of a 10 kg order and will not send the rest
-- left the order "part received" for ever, and the alerts kept promising the
-- missing 2 kg. Closing it records that the rest is not coming.
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_po_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_po_status_check
  CHECK (po_status IN ('draft', 'ordered', 'partial', 'received', 'closed', 'cancelled'));

ALTER TABLE purchase_orders
  ADD COLUMN closed_reason VARCHAR(200);

-- === Suppliers: credit terms as a number ===
-- "15 days credit" as free text cannot give a due date. The text stays for
-- anything unusual; the number drives due dates and ageing.
ALTER TABLE suppliers
  ADD COLUMN credit_days INTEGER CHECK (credit_days IS NULL OR credit_days BETWEEN 0 AND 365);

-- === Goods receipts: every delivery, with or without a purchase order ===
-- One row per delivery as the supplier billed it: their bill number and date,
-- the price they actually charged, GST, and what was turned away at the door.
-- A delivery against a purchase order links to it; the daily vegetable and
-- meat buying that never has one is simply a receipt without an order. What
-- a supplier is owed is the sum of these, which is what their bills say.
CREATE TABLE goods_receipts (
  id                 BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  receipt_number     VARCHAR(30)   NOT NULL,
  supplier_id        BIGINT        NOT NULL REFERENCES suppliers(id),
  purchase_order_id  BIGINT        REFERENCES purchase_orders(id),
  -- The store the goods went into; NULL is the main store.
  outlet_id          BIGINT        REFERENCES outlets(id),
  bill_number        VARCHAR(50),
  bill_date          DATE          NOT NULL,
  received_date      DATE          NOT NULL,
  -- Bill date plus the supplier's credit days, for bills bought on credit.
  due_date           DATE,
  payment_mode       VARCHAR(10)   NOT NULL DEFAULT 'credit'
                     CHECK (payment_mode IN ('credit', 'paid')),
  prices_include_tax BOOLEAN       NOT NULL DEFAULT FALSE,
  taxable_amount     NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (taxable_amount >= 0),
  tax_amount         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  -- The paise a supplier rounds their bill to, so the total matches the paper.
  round_off          NUMERIC(8,2)  NOT NULL DEFAULT 0 CHECK (round_off BETWEEN -5 AND 5),
  total_amount       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  receipt_status     VARCHAR(10)   NOT NULL DEFAULT 'posted'
                     CHECK (receipt_status IN ('posted', 'void')),
  void_reason        VARCHAR(200),
  voided_at          TIMESTAMPTZ,
  voided_by          BIGINT        REFERENCES users(id),
  notes              TEXT,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by         BIGINT        REFERENCES users(id),
  updated_by         BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, receipt_number),
  CONSTRAINT chk_goods_receipts_void CHECK (
    (receipt_status = 'void') = (void_reason IS NOT NULL)
  )
);

-- The same supplier bill entered twice is the classic way a supplier gets paid
-- twice, so a live bill number can exist once per supplier.
CREATE UNIQUE INDEX uq_goods_receipts_bill
  ON goods_receipts (restaurant_id, supplier_id, LOWER(bill_number))
  WHERE bill_number IS NOT NULL AND receipt_status = 'posted';
CREATE INDEX idx_goods_receipts_restaurant_date ON goods_receipts (restaurant_id, bill_date DESC);
CREATE INDEX idx_goods_receipts_supplier ON goods_receipts (supplier_id, bill_date);
CREATE INDEX idx_goods_receipts_po ON goods_receipts (purchase_order_id) WHERE purchase_order_id IS NOT NULL;

CREATE TRIGGER trg_goods_receipts_updated_at
BEFORE UPDATE ON goods_receipts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE goods_receipt_items (
  id                     BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  goods_receipt_id       BIGINT        NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  purchase_order_item_id BIGINT        REFERENCES purchase_order_items(id),
  inventory_item_id      BIGINT        NOT NULL REFERENCES inventory_items(id),
  -- Bought in a pack (a copy of it, like the PO line) or in the item's own unit.
  pack_id                BIGINT        REFERENCES inventory_item_packs(id) ON DELETE SET NULL,
  pack_name              VARCHAR(40),
  pack_size              NUMERIC(14,4) CHECK (pack_size IS NULL OR pack_size > 0),
  -- As billed, in the buying unit: accepted and turned away at the door.
  bill_quantity          NUMERIC(14,3) NOT NULL CHECK (bill_quantity >= 0),
  rejected_quantity      NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (rejected_quantity >= 0),
  rejection_reason       VARCHAR(150),
  -- Accepted, in the item's own unit: what went on the shelf.
  quantity               NUMERIC(14,3) NOT NULL CHECK (quantity >= 0),
  -- Price per buying unit as printed on the bill (per ml when bought by the
  -- ml at an order's per-unit price, hence the decimals).
  unit_price             NUMERIC(18,8) NOT NULL CHECK (unit_price >= 0),
  tax_rate               NUMERIC(5,2)  NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 40),
  taxable_amount         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (taxable_amount >= 0),
  tax_amount             NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  amount                 NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  -- What one unit on the shelf cost, GST included: a restaurant on 5% GST
  -- cannot claim the input credit back, so the tax is part of the food cost.
  unit_cost              NUMERIC(18,8) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_goods_receipt_items_something CHECK (bill_quantity > 0 OR rejected_quantity > 0)
);

CREATE INDEX idx_goods_receipt_items_receipt ON goods_receipt_items (goods_receipt_id);
CREATE INDEX idx_goods_receipt_items_item ON goods_receipt_items (inventory_item_id);

-- Deliveries received before receipts existed become one brought-forward
-- receipt per purchase order, at the order's price, so what each supplier is
-- owed is exactly what it was before this migration.
WITH received AS (
  SELECT po.id AS po_id, po.restaurant_id, po.supplier_id, po.outlet_id,
         COALESCE(po.updated_at, po.created_at)::date AS received_on,
         ROW_NUMBER() OVER (PARTITION BY po.restaurant_id ORDER BY po.id) AS seq
  FROM purchase_orders po
  WHERE EXISTS (
    SELECT 1 FROM purchase_order_items poi
    WHERE poi.purchase_order_id = po.id AND poi.received_quantity > 0
  )
)
INSERT INTO goods_receipts (restaurant_id, receipt_number, supplier_id, purchase_order_id,
                            outlet_id, bill_date, received_date, payment_mode, notes)
SELECT restaurant_id, 'GRN-' || LPAD(seq::text, 4, '0'), supplier_id, po_id, outlet_id,
       received_on, received_on, 'credit',
       'Brought forward: received before supplier bills were recorded'
FROM received;

INSERT INTO goods_receipt_items (goods_receipt_id, purchase_order_item_id, inventory_item_id,
                                 bill_quantity, quantity, unit_price, taxable_amount,
                                 amount, unit_cost)
SELECT gr.id, poi.id, poi.inventory_item_id, poi.received_quantity, poi.received_quantity,
       poi.unit_price, ROUND(poi.received_quantity * poi.unit_price, 2),
       ROUND(poi.received_quantity * poi.unit_price, 2), poi.unit_price
FROM goods_receipts gr
JOIN purchase_order_items poi ON poi.purchase_order_id = gr.purchase_order_id
WHERE poi.received_quantity > 0;

UPDATE goods_receipts gr
SET taxable_amount = totals.value, total_amount = totals.value
FROM (
  SELECT goods_receipt_id, SUM(amount) AS value
  FROM goods_receipt_items GROUP BY goods_receipt_id
) totals
WHERE totals.goods_receipt_id = gr.id;

-- === Returns: tied to what was bought, correctable, GST-aware ===
ALTER TABLE purchase_returns
  ADD COLUMN goods_receipt_id BIGINT        REFERENCES goods_receipts(id),
  ADD COLUMN taxable_amount   NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (taxable_amount >= 0),
  ADD COLUMN tax_amount       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  ADD COLUMN return_status    VARCHAR(10)   NOT NULL DEFAULT 'posted'
                              CHECK (return_status IN ('posted', 'void')),
  ADD COLUMN void_reason      VARCHAR(200),
  ADD COLUMN voided_at        TIMESTAMPTZ,
  ADD COLUMN voided_by        BIGINT        REFERENCES users(id),
  ADD CONSTRAINT chk_purchase_returns_void CHECK ((return_status = 'void') = (void_reason IS NOT NULL));

UPDATE purchase_returns SET taxable_amount = total_amount;

ALTER TABLE purchase_return_items
  ADD COLUMN goods_receipt_item_id BIGINT       REFERENCES goods_receipt_items(id),
  ADD COLUMN tax_rate              NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (tax_rate BETWEEN 0 AND 40),
  ADD COLUMN tax_amount            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);

CREATE INDEX idx_purchase_returns_po ON purchase_returns (purchase_order_id) WHERE purchase_order_id IS NOT NULL;
CREATE INDEX idx_purchase_returns_receipt ON purchase_returns (goods_receipt_id) WHERE goods_receipt_id IS NOT NULL;

-- === Supplier payments: correctable, and cash from the till is marked ===
-- A payment typed wrong used to stay in the books for ever. It is now voided
-- (kept, struck through, with the reason) or edited with a reason in the
-- activity log. Cash handed to the vegetable vendor out of the drawer is
-- marked, with the trading day, so the day-end cash count can allow for it.
ALTER TABLE supplier_payments
  ADD COLUMN goods_receipt_id BIGINT       REFERENCES goods_receipts(id),
  ADD COLUMN payment_status   VARCHAR(10)  NOT NULL DEFAULT 'posted'
                              CHECK (payment_status IN ('posted', 'void')),
  ADD COLUMN void_reason      VARCHAR(200),
  ADD COLUMN voided_at        TIMESTAMPTZ,
  ADD COLUMN voided_by        BIGINT       REFERENCES users(id),
  ADD COLUMN paid_from_till   BOOLEAN      NOT NULL DEFAULT FALSE,
  ADD COLUMN business_date    DATE,
  ADD CONSTRAINT chk_supplier_payments_void CHECK ((payment_status = 'void') = (void_reason IS NOT NULL)),
  ADD CONSTRAINT chk_supplier_payments_till CHECK (NOT paid_from_till OR payment_method = 'cash');

CREATE INDEX idx_supplier_payments_till
  ON supplier_payments (restaurant_id, business_date)
  WHERE paid_from_till AND payment_status = 'posted';

-- === Per-size recipes ===
-- A size with its own recipe uses it. A size without one uses the dish's
-- recipe, multiplied by this factor when the owner has set one (Half = 0.5),
-- or at full quantity when they have not — the screen flags those sizes.
ALTER TABLE product_variants
  ADD COLUMN recipe_factor NUMERIC(6,3) CHECK (recipe_factor IS NULL OR (recipe_factor > 0 AND recipe_factor <= 10));

-- === Stock counts ===
-- The weekly (or nightly) count is how a kitchen finds theft, over-portioning
-- and waste nobody logged. A count sheet lists the items in one store, in the
-- order you walk it; people type what is on the shelf; the system works out
-- what it expected at the moment each item was counted, and posting the sheet
-- moves stock to what was counted, each difference with a reason.
CREATE TABLE stock_counts (
  id              BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id   BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  count_number    VARCHAR(30)   NOT NULL,
  -- The store counted; NULL is the main store.
  outlet_id       BIGINT        REFERENCES outlets(id),
  -- Set when the whole sheet was counted at one moment (after closing, say)
  -- and typed in later. Left empty, each line is compared at the moment it
  -- was entered, so sales billed while people count do not show as variance.
  counted_at      TIMESTAMPTZ,
  business_date   DATE,
  -- Which categories and storage areas the sheet covers, for the history.
  scope           JSONB         NOT NULL DEFAULT '{}'::jsonb,
  -- A blind count hides the expected figures from the people counting, so
  -- they count what is there rather than confirm what the screen says.
  blind           BOOLEAN       NOT NULL DEFAULT FALSE,
  count_status    VARCHAR(12)   NOT NULL DEFAULT 'draft'
                  CHECK (count_status IN ('draft', 'posted', 'cancelled')),
  notes           TEXT,
  shortage_value  NUMERIC(14,2) NOT NULL DEFAULT 0,
  excess_value    NUMERIC(14,2) NOT NULL DEFAULT 0,
  posted_at       TIMESTAMPTZ,
  posted_by       BIGINT        REFERENCES users(id),
  cancelled_at    TIMESTAMPTZ,
  cancelled_by    BIGINT        REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by      BIGINT        REFERENCES users(id),
  updated_by      BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, count_number)
);

CREATE INDEX idx_stock_counts_restaurant ON stock_counts (restaurant_id, created_at DESC);

CREATE TRIGGER trg_stock_counts_updated_at
BEFORE UPDATE ON stock_counts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_count_lines (
  id                BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stock_count_id    BIGINT        NOT NULL REFERENCES stock_counts(id) ON DELETE CASCADE,
  inventory_item_id BIGINT        NOT NULL REFERENCES inventory_items(id),
  counted_quantity  NUMERIC(14,3) CHECK (counted_quantity IS NULL OR counted_quantity >= 0),
  -- When this line's count was typed in (see counted_at on the sheet).
  entered_at        TIMESTAMPTZ,
  entered_by        BIGINT        REFERENCES users(id),
  -- Frozen when the sheet is posted: what the system expected, the
  -- difference, and its value at the cost of the day.
  system_quantity   NUMERIC(14,3),
  variance_quantity NUMERIC(14,3),
  unit_cost         NUMERIC(18,8),
  variance_value    NUMERIC(14,2),
  reason            VARCHAR(24)
                    CHECK (reason IS NULL OR reason IN (
                      'unexplained', 'wastage_not_logged', 'staff_meals', 'over_portioning',
                      'theft', 'delivery_not_entered', 'count_error', 'other'
                    )),
  note              VARCHAR(200),
  UNIQUE (stock_count_id, inventory_item_id)
);

CREATE INDEX idx_stock_count_lines_item ON stock_count_lines (inventory_item_id);

-- === Permissions ===
-- Raising an order, receiving the goods and paying for them were one or two
-- permissions, so one person could do all three with no second pair of eyes —
-- the classic purchase fraud. Each is now separate. Counting is separate from
-- posting: the cook counts the walk-in, a manager posts the differences.
INSERT INTO permissions (code, module, name) VALUES
  ('purchasing.receive', 'purchasing', 'Receive goods and enter supplier bills'),
  ('purchasing.pay', 'purchasing', 'Pay suppliers and correct payments'),
  ('inventory.count', 'inventory', 'Count stock (enter counted quantities)');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('purchasing.receive', 'purchasing.pay', 'inventory.count')
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE
  AND r.code IN ('SUPER_ADMIN', 'RESTAURANT_ADMIN', 'MANAGER')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code = 'inventory.count'
WHERE r.restaurant_id IS NULL AND r.is_system = TRUE AND r.code = 'KITCHEN'
ON CONFLICT DO NOTHING;

-- Nobody loses what they could already do, including a restaurant's own
-- roles: receiving came with purchasing.manage, paying with purchasing.returns,
-- counting with inventory.manage.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, granted.id
FROM role_permissions rp
JOIN permissions held ON held.id = rp.permission_id
JOIN permissions granted ON
  (held.code = 'purchasing.manage' AND granted.code = 'purchasing.receive')
  OR (held.code = 'purchasing.returns' AND granted.code = 'purchasing.pay')
  OR (held.code = 'inventory.manage' AND granted.code = 'inventory.count')
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions
  WHERE code IN ('purchasing.receive', 'purchasing.pay', 'inventory.count')
);
DELETE FROM permissions WHERE code IN ('purchasing.receive', 'purchasing.pay', 'inventory.count');

DROP TABLE IF EXISTS stock_count_lines;
DROP TABLE IF EXISTS stock_counts;

ALTER TABLE product_variants DROP COLUMN IF EXISTS recipe_factor;

DROP INDEX IF EXISTS idx_supplier_payments_till;
-- Without its status a voided payment would count as paid again.
DELETE FROM supplier_payments WHERE payment_status = 'void';
ALTER TABLE supplier_payments
  DROP CONSTRAINT IF EXISTS chk_supplier_payments_till,
  DROP CONSTRAINT IF EXISTS chk_supplier_payments_void,
  DROP COLUMN IF EXISTS business_date,
  DROP COLUMN IF EXISTS paid_from_till,
  DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS voided_at,
  DROP COLUMN IF EXISTS void_reason,
  DROP COLUMN IF EXISTS payment_status,
  DROP COLUMN IF EXISTS goods_receipt_id;

DROP INDEX IF EXISTS idx_purchase_returns_receipt;
DROP INDEX IF EXISTS idx_purchase_returns_po;
ALTER TABLE purchase_return_items
  DROP COLUMN IF EXISTS tax_amount,
  DROP COLUMN IF EXISTS tax_rate,
  DROP COLUMN IF EXISTS goods_receipt_item_id;

-- A voided return put its stock back; with the status gone it would count
-- again, so the rows go the way a void means.
DELETE FROM purchase_returns WHERE return_status = 'void';
ALTER TABLE purchase_returns
  DROP CONSTRAINT IF EXISTS chk_purchase_returns_void,
  DROP COLUMN IF EXISTS voided_by,
  DROP COLUMN IF EXISTS voided_at,
  DROP COLUMN IF EXISTS void_reason,
  DROP COLUMN IF EXISTS return_status,
  DROP COLUMN IF EXISTS tax_amount,
  DROP COLUMN IF EXISTS taxable_amount,
  DROP COLUMN IF EXISTS goods_receipt_id;

DROP TABLE IF EXISTS goods_receipt_items;
DROP TABLE IF EXISTS goods_receipts;

ALTER TABLE suppliers DROP COLUMN IF EXISTS credit_days;

UPDATE purchase_orders SET po_status = 'partial' WHERE po_status = 'closed';
ALTER TABLE purchase_orders DROP COLUMN IF EXISTS closed_reason;
ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS purchase_orders_po_status_check;
ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_po_status_check
  CHECK (po_status IN ('draft', 'ordered', 'partial', 'received', 'cancelled'));

ALTER TABLE purchase_order_items
  DROP COLUMN IF EXISTS pack_price,
  DROP COLUMN IF EXISTS pack_quantity,
  DROP COLUMN IF EXISTS pack_size,
  DROP COLUMN IF EXISTS pack_name,
  DROP COLUMN IF EXISTS pack_id;

DROP TABLE IF EXISTS inventory_item_packs;

ALTER TABLE inventory_items DROP COLUMN IF EXISTS storage_area;

DROP INDEX IF EXISTS idx_stock_transactions_reference;
DROP INDEX IF EXISTS idx_stock_transactions_cost;
ALTER TABLE stock_transactions DROP COLUMN IF EXISTS sets_cost;

DELETE FROM document_counters WHERE series IN ('PO', 'PR', 'GRN', 'SC');

DROP INDEX IF EXISTS idx_stock_transactions_restaurant_effective;
DROP INDEX IF EXISTS idx_stock_transactions_effective;
ALTER TABLE stock_transactions DROP COLUMN IF EXISTS effective_at;

ALTER TABLE purchase_return_items ALTER COLUMN unit_price TYPE NUMERIC(12,2);
ALTER TABLE purchase_order_items ALTER COLUMN unit_price TYPE NUMERIC(12,2);
ALTER TABLE stock_transactions ALTER COLUMN unit_cost TYPE NUMERIC(12,2);
ALTER TABLE inventory_items ALTER COLUMN last_cost TYPE NUMERIC(12,2);

ALTER TABLE outlets DROP COLUMN IF EXISTS own_store;
