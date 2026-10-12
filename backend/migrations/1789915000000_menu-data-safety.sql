-- Up Migration

-- Menu data safety (menu audit B7, B8, B4).
--
-- The screens and the API already refuse these mistakes with a sentence a
-- manager can act on. These rules sit underneath them so that no other way in
-- — a bulk import, a price revision, a script, a future screen — can leave the
-- menu in a state the till cannot sell from.

-- 1. A size's price can never go below zero.
--
-- A size is stored as a difference from the dish price (Half = -150), so the
-- price the guest pays depends on two rows. Cutting the dish from 300 to 100
-- left Half at -50; the next Half plate rung up failed at the till with
-- "Internal server error" because an order line cannot be negative.
--
-- Only sizes that are switched on count: a retired size cannot be sold, and
-- switching it back on is checked again. The check is deferred to the end of
-- the transaction because an import or a price revision moves the dish price
-- and its sizes' differences together; between the two statements the sum is
-- briefly meaningless.
--
-- Two saves at the same moment (one cuts the dish price, the other widens the
-- Half's discount) would each pass on its own, because neither can see the
-- other's uncommitted change. So the check first takes a short per-restaurant
-- lock: the second save waits for the first to commit, and its check then
-- reads the menu with the first save in it. Each statement of this function
-- reads the latest committed data, so the SELECT after the lock sees it.
-- (Lock key 915003 is this rule's own; 915001 is the menu import and price
-- revision, 915002 the combo rule below.)
CREATE OR REPLACE FUNCTION menu_size_price_not_negative() RETURNS trigger AS $$
DECLARE
  bad RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(915003, NEW.restaurant_id::int);

  SELECT p.name AS dish, v.name AS size, (p.price + v.price_delta) AS final_price
    INTO bad
    FROM product_variants v
    JOIN products p ON p.id = v.product_id
   WHERE v.status = 'active'
     AND p.price + v.price_delta < 0
     AND ((TG_TABLE_NAME = 'products' AND v.product_id = NEW.id)
          OR (TG_TABLE_NAME = 'product_variants' AND v.id = NEW.id))
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'The size "%" of "%" would cost %, and a price cannot be below zero',
      bad.size, bad.dish, bad.final_price
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_menu_size_price_not_negative';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_products_size_prices_not_negative
AFTER UPDATE OF price ON products
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION menu_size_price_not_negative();

CREATE CONSTRAINT TRIGGER trg_product_variants_price_not_negative
AFTER INSERT OR UPDATE ON product_variants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION menu_size_price_not_negative();

-- 2. Combos are one level deep.
--
-- The code refused putting a combo inside another, but not the other way
-- round: a dish already inside a thali could be turned into a combo itself.
-- Stock consumption only looks one level down, so that thali would quietly
-- stop taking the inner dish's ingredients out of stock. Checked at the end of
-- the transaction because the editor saves a combo by deleting its parts and
-- inserting the new list.
--
-- Two editors saving at the same moment ("make A a combo of B" while "make C
-- a combo of A") each passed this check, because neither could see the
-- other's parts before they were committed, and together they nested C -> A
-- -> B. The per-restaurant lock makes the second save wait for the first and
-- then check against it, so one of the two is refused. The combo editor takes
-- the same lock before its own checks (combo.repository), so the refusal it
-- gives names the combo.
CREATE OR REPLACE FUNCTION menu_combo_one_level() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(915002, NEW.restaurant_id::int);

  IF EXISTS (SELECT 1 FROM combo_items WHERE combo_product_id = NEW.product_id)
     OR EXISTS (SELECT 1 FROM combo_items WHERE product_id = NEW.combo_product_id) THEN
    RAISE EXCEPTION 'A combo cannot contain another combo'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'chk_menu_combo_one_level';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_combo_items_one_level
AFTER INSERT OR UPDATE ON combo_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION menu_combo_one_level();

-- 3. "Has this ever been sold?"
--
-- Asked before a dish, size or add-on is deleted, so the answer can be "it has
-- been sold 42 times — archive it instead" rather than a foreign-key error.
-- The database asks the same question on every delete (the order lines point
-- at the menu with no delete rule), and without these it reads every order
-- line to answer it.
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items (product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_variant_id
  ON order_items (product_variant_id) WHERE product_variant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_order_item_modifiers_modifier_id
  ON order_item_modifiers (modifier_id) WHERE modifier_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_order_item_modifiers_modifier_id;
DROP INDEX IF EXISTS idx_order_items_product_variant_id;
DROP INDEX IF EXISTS idx_order_items_product_id;

DROP TRIGGER IF EXISTS trg_combo_items_one_level ON combo_items;
DROP FUNCTION IF EXISTS menu_combo_one_level();

DROP TRIGGER IF EXISTS trg_product_variants_price_not_negative ON product_variants;
DROP TRIGGER IF EXISTS trg_products_size_prices_not_negative ON products;
DROP FUNCTION IF EXISTS menu_size_price_not_negative();
