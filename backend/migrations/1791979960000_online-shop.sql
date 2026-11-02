-- Up Migration
-- The online shop: a goods shop's customers order from the shop's own link on
-- the guests' site (/shop/<token>) for pickup or delivery, and the shop's
-- staff accept, pack, bill and hand over each order from Business Admin ›
-- Online orders. The shop sells its own stock at its walk-in prices (an
-- inventory e-commerce entity under the Consumer Protection (E-Commerce)
-- Rules 2020), so every shop page carries the seller's details and policy,
-- and a customer's complaint gets a ticket and its clocks.
--
--   online_shop (module)      the application, sold on its own (₹399 a month,
--                             ₹3,999 a year to start), for the goods shops;
--                             it needs Sales and Customers & suppliers
--   shop_settings             one shop link per location, the location whose
--                             stock it sells: its random token, on or paused,
--                             pickup and delivery (PIN codes, the charge, free
--                             above, the minimum order, two-hour slots with a
--                             cap each and a same-day cut-off), how long an
--                             order may wait before it is declined
--                             automatically, the payment modes, the UPI ID the
--                             order slip's QR pays, the seller's customer care,
--                             grievance officer, FSSAI licence and policy, and
--                             the "Delivery charge" service item its bills use
--   shop_blocked_mobiles      mobiles staff stopped from ordering online, with
--                             the reason; lifted, never deleted
--   shop_counters             the order (ON-0001) and complaint ticket
--                             (TK-0001) numbers of each business: not tax
--                             invoices, the bill gets its own number
--   shop_orders               a guest's order: who, where, when, how they pay,
--                             what to do with an item that has run out, the
--                             consents they ticked, the cart's figures, the
--                             most they agreed to pay, its status and times,
--                             the customer record made at acceptance, the bill
--                             and the return of a bill refused at the door
--   shop_order_lines          each item ordered at the price the guest saw,
--                             and as packed: short, unavailable, weighed or
--                             replaced (the replacement is a line of its own)
--   shop_order_changes        a change that would make the guest pay more than
--                             they agreed (a dearer replacement, an added item,
--                             a weighed item more than 10% over), waiting for
--                             their OK on the status page or by phone
--   shop_complaints           "Report a problem": a ticket acknowledged within
--                             48 hours and resolved within a month
--   shop_item_details         a product's photo, "Show in online shop" and its
--                             online details (the packaged goods declarations)
--   shop_hidden_categories    categories kept off the online shop
--
-- The rules that keep an item off the shop whatever the settings say
-- (services, prescription medicines, tobacco, alcohol, contact lenses …) are
-- in one place in the code (modules/business/shop/services/shopRules.js),
-- applied to every list, search, item page, cart check and order.
--
-- Live updates: an order and a complaint announce themselves (areas
-- online_order and online_complaint), so the staff's board and the guest's
-- status page move together; every change to an order's lines raises the
-- order's revision, so the order's own row announces them.

-- --- The module, its price, permissions and roles --------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('online_shop', 'Online shop', 'Customers order from the shop''s own link for pickup or delivery; staff accept, pack, bill and hand over each order, with complaints and their clocks.', 'optional', 127);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('online_shop', 'sales'), ('online_shop', 'contacts');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default)
SELECT 'online_shop', t.code, FALSE FROM unnest(ARRAY['grocery', 'supermarket', 'fashion', 'electronics', 'pharmacy', 'books', 'meat', 'weight_retail',
  'general_retail', 'hardware', 'agri_inputs', 'optical']) AS t(code);

INSERT INTO platform_module_prices (module_code, sold_as, monthly_price, yearly_price) VALUES ('online_shop', 'application', 399, 3999);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('online_shop', 'view', 'See online orders, their customers and complaints, and the shop link''s settings', 590),
 ('online_shop', 'approve', 'Accept or decline online orders', 591),
 ('online_shop', 'edit', 'Pack online orders, ask the customer about changes, and send them out or hand them over', 592),
 ('online_shop', 'cancel', 'Cancel accepted online orders, with a reason the customer sees', 593),
 ('online_shop', 'review', 'Acknowledge and resolve complaints about online orders', 594),
 ('online_shop', 'manage', 'Set up the online shop: its link, delivery, payments, what shows online, and mobiles blocked from ordering', 595),
 ('online_shop', 'export', 'Export online orders and their report', 596)
) AS p(module_code, action, name, sort_order);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'online_shop'
UNION ALL SELECT 'cashier', unnest(ARRAY['online_shop.view', 'online_shop.approve', 'online_shop.edit', 'online_shop.cancel', 'online_shop.review'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['online_shop.view', 'online_shop.edit'])
UNION ALL SELECT 'accountant', unnest(ARRAY['online_shop.view', 'online_shop.export'])
UNION ALL SELECT 'viewer', unnest(ARRAY['online_shop.view', 'online_shop.export'])
UNION ALL SELECT 'pharmacist', unnest(ARRAY['online_shop.view', 'online_shop.approve', 'online_shop.edit', 'online_shop.cancel', 'online_shop.review']);

-- Existing businesses' copies of the same templates (harmless where the module
-- cannot be switched on; keeps "role copy = template").
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'online_shop'
WHERE NOT r.full_access
ON CONFLICT DO NOTHING;

-- --- The shop link and its settings -----------------------------------------------------------

CREATE TABLE shop_settings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  -- 192 random bits as 48 hex characters: the link's only name.
  token CHAR(48) NOT NULL UNIQUE CHECK (token ~ '^[a-f0-9]{48}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  -- A busy hour: the shop shows, takes nothing, and says so.
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  pickup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pickup_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (pickup_minutes BETWEEN 5 AND 720),
  delivery_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_pins TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(delivery_pins) <= 100),
  delivery_area_note VARCHAR(300),
  delivery_fee NUMERIC(10,2) NOT NULL DEFAULT 30 CHECK (delivery_fee BETWEEN 0 AND 1000),
  -- NULL: never free.
  free_delivery_above NUMERIC(12,2) DEFAULT 500 CHECK (free_delivery_above IS NULL OR free_delivery_above > 0),
  min_order NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (min_order BETWEEN 0 AND 100000),
  -- "As soon as possible (about 60 min)".
  delivery_minutes SMALLINT NOT NULL DEFAULT 60 CHECK (delivery_minutes BETWEEN 10 AND 1440),
  -- Two-hour delivery slots: [{ "from": "10:00", "to": "12:00", "cap": 10 }],
  -- each taking orders until slot_cutoff_minutes before it starts.
  slots_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  slots JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(slots) = 'array' AND jsonb_array_length(slots) <= 12),
  slot_cutoff_minutes SMALLINT NOT NULL DEFAULT 60 CHECK (slot_cutoff_minutes BETWEEN 0 AND 720),
  take_orders_when_closed BOOLEAN NOT NULL DEFAULT TRUE,
  hide_out_of_stock BOOLEAN NOT NULL DEFAULT TRUE,
  -- "Only 3 left" below this many in usable stock.
  low_stock_below SMALLINT NOT NULL DEFAULT 5 CHECK (low_stock_below BETWEEN 0 AND 1000),
  max_open_per_mobile SMALLINT NOT NULL DEFAULT 2 CHECK (max_open_per_mobile BETWEEN 1 AND 10),
  -- Counted from the shop's opening time for an order placed while it was closed.
  auto_decline_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (auto_decline_minutes BETWEEN 10 AND 240),
  pay_at_shop BOOLEAN NOT NULL DEFAULT TRUE,
  cash_on_delivery BOOLEAN NOT NULL DEFAULT TRUE,
  upi_on_delivery BOOLEAN NOT NULL DEFAULT TRUE,
  upi_id VARCHAR(100) CHECK (upi_id ~ '^[A-Za-z0-9._-]{2,100}@[A-Za-z][A-Za-z0-9.-]{1,63}$'),
  upi_payee VARCHAR(100),
  guest_note VARCHAR(500),
  -- The seller's details every shop page shows (E-Commerce Rules r.4(2), 4(4)).
  care_phone VARCHAR(20),
  care_email VARCHAR(150),
  grievance_name VARCHAR(100),
  grievance_designation VARCHAR(100),
  grievance_phone VARCHAR(20),
  grievance_email VARCHAR(150),
  fssai_licence VARCHAR(14) CHECK (fssai_licence ~ '^[0-9]{14}$'),
  -- Return, refund, exchange, warranty and delivery terms (r.7(1)).
  policy VARCHAR(4000) NOT NULL,
  -- The "Delivery charge" service item a bill's delivery lines are on.
  delivery_sku_id BIGINT,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, location_id),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, delivery_sku_id) REFERENCES catalog_skus(business_id, id),
  CHECK (pickup_enabled OR delivery_enabled),
  CHECK (pay_at_shop OR cash_on_delivery OR upi_on_delivery)
);

CREATE TABLE shop_blocked_mobiles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  mobile CHAR(10) NOT NULL CHECK (mobile ~ '^[6-9][0-9]{9}$'),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  blocked_by BIGINT NOT NULL REFERENCES users(id),
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifted_by BIGINT REFERENCES users(id),
  lifted_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  CHECK ((lifted_at IS NULL) = (lifted_by IS NULL))
);
CREATE UNIQUE INDEX shop_blocked_mobiles_one ON shop_blocked_mobiles (business_id, mobile) WHERE lifted_at IS NULL;

CREATE TABLE shop_counters (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  kind TEXT NOT NULL CHECK (kind IN ('order', 'complaint')),
  next_number INT NOT NULL DEFAULT 1 CHECK (next_number > 0),
  PRIMARY KEY (business_id, kind)
);

-- --- Orders ----------------------------------------------------------------------------------

CREATE TABLE shop_orders (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  settings_id BIGINT NOT NULL,
  order_no VARCHAR(20) NOT NULL,
  -- The guest's own link to the order: 192 random bits.
  guest_token CHAR(48) NOT NULL UNIQUE CHECK (guest_token ~ '^[a-f0-9]{48}$'),
  -- The guest's submission: the same key again is the same order; with
  -- another body it is refused.
  client_key VARCHAR(64) NOT NULL CHECK (client_key ~ '^[A-Za-z0-9-]{8,64}$'),
  client_hash CHAR(64) NOT NULL,
  source TEXT NOT NULL DEFAULT 'guests_site' CHECK (source = 'guests_site'),
  service TEXT NOT NULL CHECK (service IN ('pickup', 'delivery')),
  guest_name VARCHAR(150) NOT NULL,
  -- NULL once erased.
  guest_mobile CHAR(10) CHECK (guest_mobile ~ '^[6-9][0-9]{9}$'),
  address VARCHAR(500),
  landmark VARCHAR(200),
  pin_code CHAR(6) CHECK (pin_code ~ '^[1-9][0-9]{5}$'),
  -- A delivery slot chosen, or NULL for "as soon as possible".
  slot_on DATE,
  slot_from TIME,
  slot_to TIME,
  payment_mode TEXT NOT NULL CHECK (payment_mode IN ('pay_at_shop', 'cash_on_delivery', 'upi_on_delivery')),
  -- What to do with an item that has run out: the order's choice; a line may have its own.
  substitution TEXT NOT NULL DEFAULT 'remove' CHECK (substitution IN ('remove', 'similar', 'call')),
  guest_note VARCHAR(500),
  -- What the guest ticked, recorded on the customer record at acceptance.
  consents TEXT[] NOT NULL DEFAULT '{}',
  privacy_notice_id BIGINT,
  status TEXT NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed', 'accepted', 'packed', 'ready', 'out_for_delivery', 'completed', 'declined', 'cancelled')),
  -- When an order still placed is declined by the shop's own rule.
  auto_decline_at TIMESTAMPTZ NOT NULL,
  -- Packing started: the guest can no longer cancel.
  packing_at TIMESTAMPTZ,
  decline_reason VARCHAR(300),
  declined_auto BOOLEAN NOT NULL DEFAULT FALSE,
  cancel_reason VARCHAR(300),
  cancelled_by TEXT CHECK (cancelled_by IN ('guest', 'shop')),
  -- The customer record, found or made at acceptance (none for an order never accepted).
  contact_id BIGINT,
  document_id BIGINT,
  return_id BIGINT,
  rider_name VARCHAR(100),
  -- The cart's figures as the guest placed it (GST included), and the most
  -- they have agreed to pay since: a raise they accepted moves it up.
  items_total NUMERIC(14,2) NOT NULL CHECK (items_total >= 0),
  delivery_charge NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (delivery_charge >= 0),
  total NUMERIC(14,2) NOT NULL CHECK (total >= 0),
  agreed_total NUMERIC(14,2) NOT NULL CHECK (agreed_total >= 0),
  -- The bill's total, once billed.
  final_total NUMERIC(14,2),
  paid_by TEXT CHECK (paid_by IN ('cash', 'upi', 'card', 'bank', 'cheque', 'account')),
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  accepted_by BIGINT REFERENCES users(id),
  packed_at TIMESTAMPTZ,
  packed_by BIGINT REFERENCES users(id),
  ready_at TIMESTAMPTZ,
  out_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completed_by BIGINT REFERENCES users(id),
  declined_at TIMESTAMPTZ,
  declined_by BIGINT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user BIGINT REFERENCES users(id),
  -- Raised with every change to the order or its lines (live updates, two staff at once).
  revision INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_no),
  UNIQUE (settings_id, client_key),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, settings_id) REFERENCES shop_settings(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (business_id, privacy_notice_id) REFERENCES business_privacy_notices(business_id, id),
  CHECK ((slot_on IS NULL) = (slot_from IS NULL) AND (slot_from IS NULL) = (slot_to IS NULL)),
  CHECK (status NOT IN ('packed', 'ready', 'out_for_delivery', 'completed') OR document_id IS NOT NULL),
  CHECK (status <> 'declined' OR decline_reason IS NOT NULL),
  CHECK (status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX shop_orders_board ON shop_orders (business_id, status, placed_at);
CREATE INDEX shop_orders_mobile ON shop_orders (business_id, guest_mobile) WHERE status IN ('placed', 'accepted', 'packed', 'ready', 'out_for_delivery');
CREATE INDEX shop_orders_contact ON shop_orders (business_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX shop_orders_slots ON shop_orders (settings_id, slot_on, slot_from) WHERE slot_on IS NOT NULL;

CREATE TABLE shop_order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_id BIGINT NOT NULL,
  position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 200),
  sku_id BIGINT NOT NULL,
  name VARCHAR(200) NOT NULL,
  unit VARCHAR(20) NOT NULL,
  -- Ordered, in the item's own unit (about this much for a weighed item).
  quantity NUMERIC(12,3) NOT NULL CHECK (quantity > 0),
  -- One unit at the price the guest saw, GST included; its MRP and slab then.
  price NUMERIC(14,2) NOT NULL CHECK (price >= 0),
  mrp NUMERIC(14,2),
  tax_rate NUMERIC(5,2) NOT NULL,
  weighed BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL: the order's own choice.
  substitution TEXT CHECK (substitution IN ('remove', 'similar', 'call')),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'ok', 'short', 'unavailable', 'replaced')),
  packed_quantity NUMERIC(12,3) CHECK (packed_quantity >= 0),
  picked BOOLEAN NOT NULL DEFAULT FALSE,
  -- A lower price staff gave (their discount permission), with its reason.
  bill_price NUMERIC(14,2) CHECK (bill_price >= 0),
  discount_reason VARCHAR(200),
  -- Serial numbers chosen at packing, one per unit.
  serials TEXT[] NOT NULL DEFAULT '{}',
  -- A line the shop added (the guest asked on the phone), or the replacement of another.
  added BOOLEAN NOT NULL DEFAULT FALSE,
  replaces_line_id BIGINT,
  note VARCHAR(200),
  UNIQUE (business_id, id),
  UNIQUE (order_id, position),
  FOREIGN KEY (business_id, order_id) REFERENCES shop_orders(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, replaces_line_id) REFERENCES shop_order_lines(business_id, id),
  CHECK (bill_price IS NULL OR (bill_price <= price AND discount_reason IS NOT NULL)),
  CHECK (replaces_line_id IS NULL OR added)
);
CREATE INDEX shop_order_lines_order ON shop_order_lines (business_id, order_id);

CREATE TABLE shop_order_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  order_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'accepted', 'rejected', 'withdrawn')),
  -- The guest's own answer on the status page, or theirs on the phone, typed by staff.
  answered_via TEXT CHECK (answered_via IN ('guest', 'phone')),
  -- The most the guest had agreed to pay, and what the order comes to now.
  total_before NUMERIC(14,2) NOT NULL,
  total_after NUMERIC(14,2) NOT NULL,
  -- What changed, in the guest's words: [{ name, was, now, amountBefore, amountAfter }].
  lines JSONB NOT NULL CHECK (jsonb_typeof(lines) = 'array'),
  note VARCHAR(300),
  asked_by BIGINT NOT NULL REFERENCES users(id),
  asked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at TIMESTAMPTZ,
  answered_by BIGINT REFERENCES users(id),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES shop_orders(business_id, id),
  CHECK (total_after > total_before),
  CHECK ((status = 'waiting') = (answered_at IS NULL))
);
CREATE UNIQUE INDEX shop_order_changes_waiting ON shop_order_changes (order_id) WHERE status = 'waiting';

-- --- Complaints ------------------------------------------------------------------------------

CREATE TABLE shop_complaints (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  order_id BIGINT NOT NULL,
  contact_id BIGINT,
  ticket_no VARCHAR(20) NOT NULL,
  client_key VARCHAR(64) NOT NULL CHECK (client_key ~ '^[A-Za-z0-9-]{8,64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('missing', 'wrong', 'damaged', 'expired', 'quality', 'late', 'billing', 'other')),
  details VARCHAR(1000) NOT NULL CHECK (btrim(details) <> ''),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  -- Acknowledged within 48 hours, resolved within a month (E-Commerce Rules r.4(5)).
  acknowledge_by TIMESTAMPTZ NOT NULL,
  resolve_by TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by BIGINT REFERENCES users(id),
  acknowledgement VARCHAR(500),
  resolved_at TIMESTAMPTZ,
  resolved_by BIGINT REFERENCES users(id),
  outcome TEXT CHECK (outcome IN ('taken_back', 'refunded', 'replaced', 'explained', 'other')),
  resolution VARCHAR(1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, ticket_no),
  UNIQUE (order_id, client_key),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES shop_orders(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  CHECK (status = 'open' OR acknowledged_at IS NOT NULL),
  CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CHECK (status <> 'resolved' OR (outcome IS NOT NULL AND resolution IS NOT NULL))
);
CREATE INDEX shop_complaints_open ON shop_complaints (business_id, status, created_at);

-- --- What shows online -----------------------------------------------------------------------

CREATE TABLE shop_item_details (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  product_id BIGINT NOT NULL,
  -- "Show in online shop" switched off.
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  -- A product picture (public, as the restaurant's dish photos): the large
  -- one for the item's page and the small one for the shop's grid.
  photo_path VARCHAR(200),
  thumb_path VARCHAR(200),
  description VARCHAR(500),
  -- Legal Metrology (Packaged Commodities) Rules r.6(1), shown online by r.6(10).
  maker_kind TEXT CHECK (maker_kind IN ('manufacturer', 'packer', 'importer')),
  maker_name VARCHAR(150),
  maker_address VARCHAR(300),
  country_of_origin VARCHAR(60),
  generic_name VARCHAR(150),
  net_quantity VARCHAR(40),
  consumer_care VARCHAR(200),
  best_before VARCHAR(100),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, product_id),
  FOREIGN KEY (business_id, product_id) REFERENCES catalog_products(business_id, id),
  CHECK ((photo_path IS NULL) = (thumb_path IS NULL))
);

CREATE TABLE shop_hidden_categories (
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  category_id BIGINT NOT NULL,
  hidden_by BIGINT NOT NULL REFERENCES users(id),
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, category_id),
  FOREIGN KEY (business_id, category_id) REFERENCES catalog_categories(business_id, id)
);

-- --- Live updates ----------------------------------------------------------------------------

CREATE TRIGGER shop_orders_live AFTER INSERT OR UPDATE OR DELETE ON shop_orders
  FOR EACH ROW EXECUTE FUNCTION live_business_row('online_order', 'id');
CREATE TRIGGER shop_complaints_live AFTER INSERT OR UPDATE OR DELETE ON shop_complaints
  FOR EACH ROW EXECUTE FUNCTION live_business_row('online_complaint', 'id');

-- Down Migration
DROP TRIGGER shop_complaints_live ON shop_complaints;
DROP TRIGGER shop_orders_live ON shop_orders;
DROP TABLE shop_hidden_categories, shop_item_details, shop_complaints, shop_order_changes, shop_order_lines, shop_orders, shop_counters,
  shop_blocked_mobiles, shop_settings;

DELETE FROM business_role_permissions WHERE permission_code LIKE 'online\_shop.%';
DELETE FROM business_role_template_permissions WHERE permission_code LIKE 'online\_shop.%';
DELETE FROM business_permissions WHERE module_code = 'online_shop';
DELETE FROM business_access_addons WHERE module_code = 'online_shop';
DELETE FROM business_subscription_addons WHERE module_code = 'online_shop';
DELETE FROM platform_plan_modules WHERE module_code = 'online_shop';
DELETE FROM platform_module_prices WHERE module_code = 'online_shop';
DELETE FROM business_capabilities WHERE capability = 'online_shop';
DELETE FROM platform_module_dependencies WHERE module_code = 'online_shop';
DELETE FROM platform_module_business_types WHERE module_code = 'online_shop';
DELETE FROM platform_modules WHERE code = 'online_shop';
