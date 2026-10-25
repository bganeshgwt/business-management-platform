-- Up Migration
-- A fuel station's back office: the dealer's own records beside the oil
-- company's forecourt systems. What each shift's nozzles gave out and what
-- each attendant handed in, posted to the core as the shift's fuel sales; the
-- tanks' morning dips, the tanker loads received with the density check, and
-- the daily stock register checked against the Marketing Discipline
-- Guidelines' tolerance; the density register; and fleet customers'
-- vehicles, their credit fills and their statements. Readings, dips and
-- densities are typed in from the meters, the dip rod and the hydrometer:
-- nothing here talks to a dispenser, a forecourt controller or a tank gauge,
-- which the oil companies own and run.
--
-- Tanks, nozzles & shifts (module "fuel", on for type "fuel_station"):
--   fuel_settings         what the registers check against (MDG 2024): a
--                         tanker load's density at 15 °C within 3.0 kg/m³ of
--                         its invoice; a day's stock within 4% of the tank's
--                         stock by dip, plus the evaporation and handling
--                         allowance on what was sold (petrol 0.75% up to an
--                         annual average of 600 KL and 0.60% beyond, diesel
--                         0.25% and 0.20%) and which side of 600 KL the
--                         outlet is on; the test measure's quantity (5 litres,
--                         pumped back); and how many days before a stamping
--                         falls due the bell warns. Each is a setting, these
--                         until changed.
--   fuel_products         each fuel sold (petrol, diesel and their premium
--                         grades, CNG): a goods item of the catalogue kept in
--                         stock, counted in litres (CNG in kilos), on the GST
--                         nil slab. Petrol, diesel and CNG are outside GST: the
--                         price includes the state's VAT or sales tax, and
--                         each bill line says so.
--   fuel_tanks            each underground tank: its number, the fuel it holds
--                         and its capacity. CNG is kept in no tank.
--   fuel_dispensers       each dispensing unit: its number, make and serial,
--                         its last Weights & Measures stamping and when it falls
--                         due again; in use, suspended (seals tampered, or a
--                         delivery variation: not used until it is re-stamped)
--                         or retired.
--   fuel_nozzles          each nozzle: its number at the outlet, its unit, the
--                         fuel and the tank it draws from, and its totaliser
--                         as last read (the next shift on it opens from there).
--   fuel_meter_changes    a totaliser replaced or reset, recorded by a manager
--                         with the reading before and after it and why.
--   fuel_measures         each outlet's verified measures (the 5-litre measure
--                         of the daily nozzle test, lube measures) and when each
--                         one's stamping falls due.
--   fuel_prices           each fuel's selling price at each outlet from the
--                         moment it takes effect; never changed: a new one is set.
--   fuel_vehicles         a fleet customer's vehicles by registration, the fuel
--                         each takes on credit and the most it takes in a fill.
--   fuel_shifts           a shift (FS/2627/0001): its attendant (DSM), when the
--                         opening readings were taken, open or closed.
--   fuel_shift_nozzles    the nozzles a shift runs, each with its opening reading.
--   fuel_shift_closes     each time a shift was closed: when the closing
--                         readings were taken, what the meters sold at the
--                         prices in force (on credit slips and to walk-in
--                         buyers), the cash counted and the other takings, the
--                         attendant's short or excess, the walk-in fuel bill;
--                         and, when a manager reopened it, when, who and why.
--   fuel_close_readings   each nozzle's closing reading and its test quantity
--                         (the 5-litre test, pumped back into the tank, is not a
--                         sale): litres sold = closing - opening - test.
--   fuel_close_products   each fuel a close sold: the price in force, its litres
--                         on credit slips and to walk-in buyers, and the money.
--   fuel_credit_slips     each credit fill of a fleet customer's vehicle on a
--                         close, billed on that customer's fuel bill of the shift.
--   fuel_close_payments   the UPI, card and fleet-card takings handed in, each
--                         paid on the walk-in fuel bill.
--   fuel_dips             each tank's morning dip: the dip read, the litres it
--                         holds from the dip chart, the water dip, and the
--                         morning density at 15 °C of a nozzle sample.
--   fuel_receipts         each tanker load: the oil company's invoice, the
--                         lorry, the seals; accepted (a purchase through the
--                         core: the stock comes in at the invoice's quantity and
--                         value) or refused; and a manager's cancellation.
--   fuel_receipt_lines    each tank a load went into: the invoice's litres,
--                         value and density at 15 °C, the lorry's sample at 15
--                         °C (within the tolerance, or a manager accepted it),
--                         the dip before and after decanting (what came in, and
--                         a short receipt), and the density after decanting.
-- A shift's sales go through the core when it closes, at the prices in force
-- and exact to the paisa (no round-off): one walk-in fuel bill (a line for
-- each fuel, paid by the UPI, card and fleet-card takings and then the cash;
-- a short is left due on it) and a fuel bill to each fleet customer (a line
-- for each credit slip, with its vehicle), so stock and money stay in the
-- core. A closed shift never changes: a manager reopens it with a reason
-- before another shift opens on its nozzles; its bills are credited, the
-- walk-in bill's takings handed back, and it is closed again. A fuel bill line
-- of a shift is credited only that way, and a tanker load's purchase line only
-- by cancelling the receipt. The walk-in fuel bill is a shift's fills to many
-- buyers, each fill its own transaction: the one-bill cash limit is not
-- checked on it.

-- --- Module, permissions and roles ------------------------------------------------------------

INSERT INTO platform_modules (code, name, description, kind, sort_order) VALUES
 ('fuel', 'Tanks, nozzles & shifts', 'Fuels under state VAT, tanks, dispensing units and nozzles with their stamping dates, and the price in force; each shift''s readings, the 5-litre test and the attendant''s settlement, posted as fuel sales; morning dips, tanker receipts with the density check, the stock register against the tolerance; fleet vehicles, credit fills and statements. Readings are typed in.', 'optional', 242);

INSERT INTO platform_module_dependencies (module_code, requires_module_code) VALUES
 ('fuel', 'catalog'), ('fuel', 'contacts'), ('fuel', 'sales'), ('fuel', 'inventory'), ('fuel', 'purchasing');

INSERT INTO platform_module_business_types (module_code, business_type, enabled_by_default) VALUES ('fuel', 'fuel_station', TRUE);

INSERT INTO business_permissions (code, module_code, action, name, sort_order)
SELECT module_code || '.' || action, module_code, action, name, sort_order FROM (VALUES
 ('fuel', 'view', 'See shifts and readings, tanks and dips, tanker receipts, the registers, fleet vehicles and the prices', 550),
 ('fuel', 'create', 'Open and close one''s own shift with its readings and takings, take the morning dips and record tanker receipts', 551),
 ('fuel', 'edit', 'Open and close shifts for any attendant, and keep fleet customers'' vehicles and their fill limits', 552),
 ('fuel', 'approve', 'Reopen shifts, allow credit over limits, accept loads outside the density tolerance, correct dips, meters and receipts', 553),
 ('fuel', 'export', 'Export shifts, the stock and density registers and fleet statements', 554),
 ('fuel', 'print', 'Print shift settlements, fleet statements and the registers', 555)
) AS p(module_code, action, name, sort_order);

-- A pump attendant (DSM): their own shift's readings and takings, and the morning dips.
INSERT INTO business_role_templates (code, name, description, full_access, sort_order, business_types) VALUES
 ('pump_attendant', 'Pump attendant (DSM)', 'Opens and closes their own shift: the nozzle readings, the 5-litre test, the cash, UPI, card and fleet-card takings and the credit slips; takes the morning dips. Sees no other attendant''s money and changes no settings.', FALSE, 31, ARRAY['fuel_station']);

INSERT INTO business_role_template_permissions (template_code, permission_code)
SELECT 'manager', code FROM business_permissions WHERE module_code = 'fuel'
UNION ALL SELECT 'cashier', unnest(ARRAY['fuel.view', 'fuel.create', 'fuel.edit', 'fuel.print'])
UNION ALL SELECT 'stock_keeper', unnest(ARRAY['fuel.view', 'fuel.create', 'fuel.print'])
UNION ALL SELECT 'accountant', unnest(ARRAY['fuel.view', 'fuel.export', 'fuel.print'])
UNION ALL SELECT 'viewer', unnest(ARRAY['fuel.view'])
UNION ALL SELECT 'pump_attendant', unnest(ARRAY['fuel.view', 'fuel.create']);

-- Existing businesses' copies of the shared templates (harmless where the
-- module cannot be switched on; keeps "role copy = template"), and the new
-- role in existing fuel stations.
INSERT INTO business_role_permissions (business_id, role_id, permission_code)
SELECT r.business_id, r.id, tp.permission_code
FROM business_roles r
JOIN business_role_template_permissions tp ON tp.template_code = r.template_code
JOIN business_permissions p ON p.code = tp.permission_code AND p.module_code = 'fuel'
WHERE NOT r.full_access AND r.template_code IN ('manager', 'cashier', 'stock_keeper', 'accountant', 'viewer')
ON CONFLICT DO NOTHING;
SELECT business_seed_roles(id) FROM businesses WHERE business_type = 'fuel_station';

-- Existing fuel stations get the tool a new one starts with (where what it needs is on).
INSERT INTO business_capabilities (business_id, capability)
SELECT b.id, t.module_code
FROM businesses b
JOIN platform_module_business_types t ON t.business_type = b.business_type AND t.enabled_by_default
WHERE t.module_code = 'fuel'
  AND NOT EXISTS (SELECT 1 FROM platform_module_dependencies d WHERE d.module_code = t.module_code
    AND NOT EXISTS (SELECT 1 FROM business_capabilities c WHERE c.business_id = b.id AND c.capability = d.requires_module_code))
ON CONFLICT DO NOTHING;

-- Shifts are numbered (FS/2627/0001). The kinds list is widened by reading
-- the current one, so kinds other migrations added are kept.
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  IF NOT 'fuel_shift' = ANY(kinds) THEN kinds := array_append(kinds, 'fuel_shift'::text); END IF;
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;

-- History is kept as it was written.
CREATE FUNCTION fuel_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'fuel_prices' THEN
    RAISE EXCEPTION 'A price is kept as it was set: set a new price to change it' USING ERRCODE = '23514';
  ELSIF TG_TABLE_NAME = 'fuel_meter_changes' THEN
    RAISE EXCEPTION 'A meter change is kept as it was recorded' USING ERRCODE = '23514';
  END IF;
  RAISE EXCEPTION 'A closed shift''s readings, sales and takings are kept as they were closed' USING ERRCODE = '23514';
END $$;

-- An instant as people read it on the business's clock: "26 Oct, 6:00 am".
CREATE FUNCTION fuel_time_words(moment TIMESTAMPTZ, tz TEXT) RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT to_char(moment AT TIME ZONE tz, 'FMDD Mon, FMHH12:MI am');
$$;

-- --- Settings ------------------------------------------------------------------------------------

-- One row per business, made when the settings are first saved.
CREATE TABLE fuel_settings (
  business_id BIGINT PRIMARY KEY REFERENCES businesses(id),
  -- A tanker load's density at 15 °C is within this many kg/m³ of its invoice's.
  density_tolerance NUMERIC(4,1) NOT NULL DEFAULT 3.0 CHECK (density_tolerance > 0 AND density_tolerance <= 20),
  -- A day's stock is within this percentage of the tank's stock by dip (the
  -- normal operational variation), plus the evaporation and handling
  -- allowance on what was sold: up to an annual average of 600 KL, or beyond.
  variation_percent NUMERIC(5,2) NOT NULL DEFAULT 4.00 CHECK (variation_percent >= 0 AND variation_percent <= 20),
  petrol_loss_percent NUMERIC(5,2) NOT NULL DEFAULT 0.75 CHECK (petrol_loss_percent >= 0 AND petrol_loss_percent <= 5),
  petrol_loss_above_percent NUMERIC(5,2) NOT NULL DEFAULT 0.60 CHECK (petrol_loss_above_percent >= 0 AND petrol_loss_above_percent <= 5),
  diesel_loss_percent NUMERIC(5,2) NOT NULL DEFAULT 0.25 CHECK (diesel_loss_percent >= 0 AND diesel_loss_percent <= 5),
  diesel_loss_above_percent NUMERIC(5,2) NOT NULL DEFAULT 0.20 CHECK (diesel_loss_above_percent >= 0 AND diesel_loss_above_percent <= 5),
  -- The outlet's annual average sales are beyond 600 KL (the allowances beyond apply).
  above_600_kl BOOLEAN NOT NULL DEFAULT FALSE,
  -- What the test measure holds: the quantity of the daily nozzle test, pumped back.
  test_litres NUMERIC(7,3) NOT NULL DEFAULT 5.000 CHECK (test_litres > 0 AND test_litres <= 100),
  -- The bell warns this many days before a stamping falls due.
  stamping_warn_days SMALLINT NOT NULL DEFAULT 30 CHECK (stamping_warn_days BETWEEN 1 AND 180),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --- Fuels -----------------------------------------------------------------------------------

CREATE TABLE fuel_products (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  -- The goods item it is sold and bought as: its name on the bill, its stock.
  sku_id BIGINT NOT NULL,
  -- Petrol (motor spirit and its premium grades), diesel (high speed diesel
  -- and its premium grades) or CNG: which allowance its register takes, and
  -- whether it is kept in a tank.
  family TEXT NOT NULL CHECK (family IN ('petrol', 'diesel', 'cng')),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, sku_id)
);

-- A fuel is a goods item kept in stock by quantity, counted in litres (CNG
-- in kilos), on the GST nil slab; it keeps its item and its family, and is
-- never deleted.
CREATE FUNCTION fuel_products_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A fuel is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sku_id <> OLD.sku_id OR NEW.family <> OLD.family OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A fuel keeps the item it is sold as and whether it is petrol, diesel or CNG' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT p.kind, s.is_kit, s.unit, s.tracking, s.tax_rate, s.label INTO item FROM catalog_skus s JOIN catalog_products p ON p.business_id = s.business_id AND p.id = s.product_id
  WHERE s.business_id = NEW.business_id AND s.id = NEW.sku_id;
  IF item.kind IS DISTINCT FROM 'goods' OR item.is_kit OR item.tracking IS DISTINCT FROM 'quantity' THEN
    RAISE EXCEPTION 'A fuel is a goods item of this business kept in stock by quantity, with no batches, serial numbers or kit' USING ERRCODE = '23514';
  END IF;
  IF item.unit IS DISTINCT FROM (CASE WHEN NEW.family = 'cng' THEN 'kg' ELSE 'litre' END) THEN
    RAISE EXCEPTION 'Petrol and diesel are sold by the litre and CNG by the kilo: % is counted in %', item.label, item.unit USING ERRCODE = '23514';
  END IF;
  IF item.tax_rate <> 0 THEN
    RAISE EXCEPTION '% is outside GST: a fuel''s item is on the GST nil slab, its price including the state''s VAT', item.label USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_products_guard BEFORE INSERT OR UPDATE OR DELETE ON fuel_products
  FOR EACH ROW EXECUTE FUNCTION fuel_products_guard();

-- A fuel's item stays on the GST nil slab, counted and kept in stock as it is.
CREATE FUNCTION fuel_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tax_rate <> 0 OR NEW.unit IS DISTINCT FROM OLD.unit OR NEW.tracking IS DISTINCT FROM OLD.tracking)
     AND EXISTS (SELECT 1 FROM fuel_products WHERE business_id = NEW.business_id AND sku_id = NEW.id) THEN
    RAISE EXCEPTION '% is a fuel, outside GST: it stays on the GST nil slab (its price includes the state''s VAT), counted and kept in stock as it is', NEW.label
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_skus_fuel_item BEFORE UPDATE OF tax_rate, unit, tracking ON catalog_skus
  FOR EACH ROW EXECUTE FUNCTION fuel_item_guard();

-- --- Tanks, dispensing units, nozzles and measures ---------------------------------------------

CREATE TABLE fuel_tanks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  tank_no VARCHAR(20) NOT NULL CHECK (btrim(tank_no) <> ''),
  -- What it holds when full, in litres.
  capacity NUMERIC(12,3) NOT NULL CHECK (capacity > 0 AND capacity <= 1000000),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, location_id, id)
);
CREATE UNIQUE INDEX fuel_tanks_number ON fuel_tanks(business_id, location_id, lower(tank_no));

-- A tank holds petrol or diesel (CNG is kept in no tank), keeps its outlet and
-- its fuel, never holds less than its last dip, and is never deleted.
CREATE FUNCTION fuel_tanks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A tank is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.location_id <> OLD.location_id OR NEW.product_id <> OLD.product_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'Tank % keeps its outlet and the fuel it holds: add another tank for another fuel', OLD.tank_no USING ERRCODE = '23514';
    END IF;
    SELECT dip_on, stock INTO latest FROM fuel_dips WHERE business_id = NEW.business_id AND tank_id = NEW.id ORDER BY dip_on DESC LIMIT 1;
    IF FOUND AND NEW.capacity < latest.stock THEN
      RAISE EXCEPTION 'Tank % held % litres at its dip of %: its capacity is not less than that', OLD.tank_no, latest.stock, to_char(latest.dip_on, 'FMDD Mon YYYY')
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF (SELECT family FROM fuel_products WHERE business_id = NEW.business_id AND id = NEW.product_id) = 'cng' THEN
    RAISE EXCEPTION 'CNG is kept in no tank: its nozzles draw from none' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_tanks_guard BEFORE INSERT OR UPDATE OR DELETE ON fuel_tanks
  FOR EACH ROW EXECUTE FUNCTION fuel_tanks_guard();

CREATE TABLE fuel_dispensers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  unit_no VARCHAR(20) NOT NULL CHECK (btrim(unit_no) <> ''),
  make VARCHAR(80) CHECK (btrim(make) <> ''),
  serial_no VARCHAR(40) CHECK (btrim(serial_no) <> ''),
  -- Its Weights & Measures stamping: the last one, and when it falls due again.
  stamped_on DATE,
  stamping_due DATE NOT NULL,
  -- In use; suspended (seals tampered, or a delivery variation: not used until
  -- it is re-stamped); or retired. A suspended or retired unit says why.
  status TEXT NOT NULL DEFAULT 'in_use' CHECK (status IN ('in_use', 'suspended', 'retired')),
  status_note VARCHAR(300) CHECK (btrim(status_note) <> ''),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, location_id, id),
  CHECK (stamped_on IS NULL OR stamping_due > stamped_on),
  CHECK (status = 'in_use' OR status_note IS NOT NULL)
);
CREATE UNIQUE INDEX fuel_dispensers_number ON fuel_dispensers(business_id, location_id, lower(unit_no));

CREATE TABLE fuel_nozzles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  dispenser_id BIGINT NOT NULL,
  -- Its number at the outlet (the global nozzle number): letters, digits, / and -.
  nozzle_no VARCHAR(10) NOT NULL CHECK (nozzle_no ~ '^[A-Z0-9][A-Z0-9/-]{0,9}$'),
  product_id BIGINT NOT NULL,
  -- The tank it draws from (none for CNG).
  tank_id BIGINT,
  -- Its totaliser as last read, in litres (kilos for CNG): the next shift on it opens from here.
  reading NUMERIC(14,3) NOT NULL CHECK (reading >= 0),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id, dispenser_id) REFERENCES fuel_dispensers(business_id, location_id, id),
  FOREIGN KEY (business_id, location_id, tank_id) REFERENCES fuel_tanks(business_id, location_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  UNIQUE (business_id, id)
);
CREATE UNIQUE INDEX fuel_nozzles_number ON fuel_nozzles(business_id, location_id, nozzle_no);
CREATE INDEX fuel_nozzles_dispenser ON fuel_nozzles(business_id, dispenser_id);

-- A unit keeps its outlet and is never deleted; it is suspended or retired
-- only while no shift is open on one of its nozzles.
CREATE FUNCTION fuel_dispensers_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE busy RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A dispensing unit is never deleted; retire it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Dispensing unit % keeps its outlet', OLD.unit_no USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'in_use' AND OLD.status = 'in_use' THEN
    SELECT n.nozzle_no, o.shift_no, o.attendant_name INTO busy FROM fuel_nozzles n CROSS JOIN LATERAL fuel_nozzle_open_shift(n.business_id, n.id) o
    WHERE n.business_id = NEW.business_id AND n.dispenser_id = NEW.id LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Shift % (%) is open on nozzle % of %: close it before taking the unit out of use', busy.shift_no, busy.attendant_name, busy.nozzle_no, OLD.unit_no
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_dispensers_guard BEFORE UPDATE OR DELETE ON fuel_dispensers
  FOR EACH ROW EXECUTE FUNCTION fuel_dispensers_guard();

-- A nozzle draws its tank's fuel (a CNG nozzle draws from no tank) and keeps
-- its outlet, unit, fuel and tank; it is switched off only while no shift is
-- open on it, and never deleted. Its totaliser reading moves only with a
-- shift's close (to its closing reading), a reopened shift (back to its
-- opening reading) or a meter change, each written in the same moment.
CREATE FUNCTION fuel_nozzles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tank RECORD; kind_of_fuel TEXT; busy RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A nozzle is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT f.family INTO kind_of_fuel FROM fuel_products f WHERE f.business_id = NEW.business_id AND f.id = NEW.product_id;
    IF (kind_of_fuel = 'cng') <> (NEW.tank_id IS NULL) THEN
      RAISE EXCEPTION 'A petrol or diesel nozzle draws from a tank; a CNG nozzle from none' USING ERRCODE = '23514';
    END IF;
    IF NEW.tank_id IS NOT NULL THEN
      SELECT product_id, tank_no INTO tank FROM fuel_tanks WHERE business_id = NEW.business_id AND id = NEW.tank_id;
      IF tank.product_id <> NEW.product_id THEN
        RAISE EXCEPTION 'Nozzle % draws the fuel of tank %', NEW.nozzle_no, tank.tank_no USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.dispenser_id <> OLD.dispenser_id OR NEW.product_id <> OLD.product_id OR NEW.tank_id IS DISTINCT FROM OLD.tank_id
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Nozzle % keeps its unit, its fuel and its tank: add another nozzle for another', OLD.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF (OLD.active AND NOT NEW.active) OR NEW.nozzle_no <> OLD.nozzle_no THEN
    SELECT * INTO busy FROM fuel_nozzle_open_shift(NEW.business_id, NEW.id);
    IF FOUND THEN
      RAISE EXCEPTION 'Shift % (%) is open on nozzle %: close it first', busy.shift_no, busy.attendant_name, OLD.nozzle_no USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.reading <> OLD.reading AND NOT (
       EXISTS (SELECT 1 FROM fuel_close_readings r JOIN fuel_shift_closes c ON c.business_id = r.business_id AND c.id = r.close_id
               WHERE r.business_id = NEW.business_id AND r.nozzle_id = NEW.id AND r.closing = NEW.reading AND c.created_at = now() AND c.reopened_at IS NULL)
    OR EXISTS (SELECT 1 FROM fuel_shift_closes c JOIN fuel_shift_nozzles n ON n.business_id = c.business_id AND n.shift_id = c.shift_id
               WHERE c.business_id = NEW.business_id AND n.nozzle_id = NEW.id AND n.opening = NEW.reading AND c.reopened_at = now())
    OR EXISTS (SELECT 1 FROM fuel_meter_changes m WHERE m.business_id = NEW.business_id AND m.nozzle_id = NEW.id AND m.to_reading = NEW.reading AND m.created_at = now())) THEN
    RAISE EXCEPTION 'Nozzle % reads % on its totaliser: the reading moves only with a shift''s close or a meter change a manager records', OLD.nozzle_no, OLD.reading
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_nozzles_guard BEFORE INSERT OR UPDATE OR DELETE ON fuel_nozzles
  FOR EACH ROW EXECUTE FUNCTION fuel_nozzles_guard();

CREATE TABLE fuel_meter_changes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  nozzle_id BIGINT NOT NULL,
  from_reading NUMERIC(14,3) NOT NULL CHECK (from_reading >= 0),
  to_reading NUMERIC(14,3) NOT NULL CHECK (to_reading >= 0),
  reason VARCHAR(300) NOT NULL CHECK (btrim(reason) <> ''),
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, nozzle_id) REFERENCES fuel_nozzles(business_id, id),
  CHECK (to_reading <> from_reading)
);
CREATE INDEX fuel_meter_changes_nozzle ON fuel_meter_changes(business_id, nozzle_id, id);
CREATE TRIGGER fuel_meter_changes_append_only BEFORE UPDATE OR DELETE ON fuel_meter_changes
  FOR EACH ROW EXECUTE FUNCTION fuel_append_only();

-- A meter change starts from the nozzle's reading, while no shift is open on
-- it, when it is written.
CREATE FUNCTION fuel_meter_changes_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE nozzle RECORD; busy RECORD;
BEGIN
  SELECT nozzle_no, reading INTO nozzle FROM fuel_nozzles WHERE business_id = NEW.business_id AND id = NEW.nozzle_id FOR UPDATE;
  IF NEW.from_reading <> nozzle.reading THEN
    RAISE EXCEPTION 'Nozzle % reads % now: a meter change starts from there', nozzle.nozzle_no, nozzle.reading USING ERRCODE = '23514';
  END IF;
  SELECT * INTO busy FROM fuel_nozzle_open_shift(NEW.business_id, NEW.nozzle_id);
  IF FOUND THEN
    RAISE EXCEPTION 'Shift % (%) is open on nozzle %: close it before the meter changes', busy.shift_no, busy.attendant_name, nozzle.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A meter change is recorded when it is written' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_meter_changes_check BEFORE INSERT ON fuel_meter_changes
  FOR EACH ROW EXECUTE FUNCTION fuel_meter_changes_check();

CREATE TABLE fuel_measures (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL CHECK (btrim(name) <> ''),
  -- What it holds, in litres.
  litres NUMERIC(7,3) NOT NULL CHECK (litres > 0 AND litres <= 100),
  serial_no VARCHAR(40) CHECK (btrim(serial_no) <> ''),
  -- Its Weights & Measures stamping: the last one, and when it falls due again.
  stamped_on DATE,
  stamping_due DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  UNIQUE (business_id, id),
  CHECK (stamped_on IS NULL OR stamping_due > stamped_on)
);

-- A measure keeps its outlet and is never deleted.
CREATE FUNCTION fuel_measures_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A measure is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.location_id <> OLD.location_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'A measure keeps its outlet' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_measures_guard BEFORE UPDATE OR DELETE ON fuel_measures
  FOR EACH ROW EXECUTE FUNCTION fuel_measures_guard();

-- --- Prices ----------------------------------------------------------------------------------

CREATE TABLE fuel_prices (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  -- The selling price of a litre (a kilo of CNG), the state's VAT included.
  price NUMERIC(10,2) NOT NULL CHECK (price > 0 AND price < 100000),
  -- From when it is the price: until the next one takes effect.
  effective_from TIMESTAMPTZ NOT NULL,
  note VARCHAR(200) CHECK (btrim(note) <> ''),
  -- The prices set together (one request) share a key.
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  UNIQUE (business_id, location_id, product_id, effective_from),
  UNIQUE (business_id, request_key, location_id, product_id)
);
CREATE INDEX fuel_prices_lookup ON fuel_prices(business_id, location_id, product_id, effective_from DESC);
CREATE TRIGGER fuel_prices_append_only BEFORE UPDATE OR DELETE ON fuel_prices
  FOR EACH ROW EXECUTE FUNCTION fuel_append_only();

-- The price of a fuel at an outlet at a moment (NULL: none set yet).
CREATE FUNCTION fuel_price_at(target_business BIGINT, target_location BIGINT, target_product BIGINT, moment TIMESTAMPTZ) RETURNS NUMERIC
LANGUAGE sql STABLE AS $$
  SELECT price FROM fuel_prices WHERE business_id = target_business AND location_id = target_location AND product_id = target_product AND effective_from <= moment
  ORDER BY effective_from DESC LIMIT 1;
$$;

-- A price is set for a fuel in use, when it is written, to take effect within
-- a week back and a month ahead, and never before a closed shift stopped
-- selling the fuel at the outlet at the price it had (a shift is priced as it
-- closed; a manager reopens it to price it again).
CREATE FUNCTION fuel_prices_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT; latest RECORD; fuel_label TEXT;
BEGIN
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  SELECT s.label INTO fuel_label FROM fuel_products f JOIN catalog_skus s ON s.business_id = f.business_id AND s.id = f.sku_id
  WHERE f.business_id = NEW.business_id AND f.id = NEW.product_id AND f.active;
  IF fuel_label IS NULL THEN
    RAISE EXCEPTION 'That fuel is switched off: switch it on to price it' USING ERRCODE = '23514';
  END IF;
  IF NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A price is set when it is written' USING ERRCODE = '23514';
  END IF;
  IF NEW.effective_from < now() - interval '7 days' OR NEW.effective_from > now() + interval '31 days' THEN
    RAISE EXCEPTION 'A price takes effect within a week back and a month ahead' USING ERRCODE = '23514';
  END IF;
  SELECT c.closed_at, s.shift_no INTO latest FROM fuel_close_products p
    JOIN fuel_shift_closes c ON c.business_id = p.business_id AND c.id = p.close_id
    JOIN fuel_shifts s ON s.business_id = c.business_id AND s.id = c.shift_id
  WHERE p.business_id = NEW.business_id AND p.product_id = NEW.product_id AND s.location_id = NEW.location_id AND c.reopened_at IS NULL
  ORDER BY c.closed_at DESC LIMIT 1;
  IF FOUND AND NEW.effective_from < latest.closed_at THEN
    RAISE EXCEPTION 'Shift % sold % at its price until %: a new price takes effect from then or later', latest.shift_no, fuel_label, fuel_time_words(latest.closed_at, zone)
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_prices_check BEFORE INSERT ON fuel_prices
  FOR EACH ROW EXECUTE FUNCTION fuel_prices_check();

-- --- Fleet vehicles --------------------------------------------------------------------------

CREATE TABLE fuel_vehicles (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  contact_id BIGINT NOT NULL,
  -- As on its plate, letters and digits only.
  registration VARCHAR(15) NOT NULL CHECK (registration ~ '^[A-Z0-9]{4,15}$'),
  description VARCHAR(150) CHECK (btrim(description) <> ''),
  -- The fuel it takes on credit (none: any), and the most it takes in one fill, in litres.
  product_id BIGINT,
  fill_limit NUMERIC(10,3) CHECK (fill_limit > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, contact_id, id)
);
-- A vehicle is with one fleet customer at a time.
CREATE UNIQUE INDEX fuel_vehicles_registration ON fuel_vehicles(business_id, registration) WHERE active;
CREATE INDEX fuel_vehicles_contact ON fuel_vehicles(business_id, contact_id);
CREATE TRIGGER fuel_vehicles_customer BEFORE INSERT ON fuel_vehicles
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_customer();

-- A vehicle keeps its customer and its registration, and is never deleted.
CREATE FUNCTION fuel_vehicles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A vehicle is never deleted; switch it off instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.contact_id <> OLD.contact_id OR NEW.registration <> OLD.registration OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Vehicle % keeps its customer and its registration: switch it off and add it again for another customer', OLD.registration USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_vehicles_guard BEFORE UPDATE OR DELETE ON fuel_vehicles
  FOR EACH ROW EXECUTE FUNCTION fuel_vehicles_guard();

-- --- Shifts ----------------------------------------------------------------------------------

CREATE TABLE fuel_shifts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  location_id BIGINT NOT NULL,
  shift_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  -- The attendant (DSM), and their name as it was.
  attendant_id BIGINT NOT NULL REFERENCES users(id),
  attendant_name VARCHAR(150) NOT NULL CHECK (btrim(attendant_name) <> ''),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  -- When the opening readings were taken.
  opened_at TIMESTAMPTZ NOT NULL,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, shift_no),
  UNIQUE (business_id, request_key),
  CHECK (opened_at <= created_at)
);
CREATE INDEX fuel_shifts_period ON fuel_shifts(business_id, opened_at DESC);
CREATE INDEX fuel_shifts_open ON fuel_shifts(business_id, location_id) WHERE status = 'open';
-- An attendant runs one shift at a time at an outlet.
CREATE UNIQUE INDEX fuel_shifts_one_open ON fuel_shifts(business_id, location_id, attendant_id) WHERE status = 'open';

-- A shift starts open, when it is written, from readings taken within the
-- last day, for an attendant who works in the business.
CREATE FUNCTION fuel_shifts_insert_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'open' OR NEW.created_at <> now() THEN
    RAISE EXCEPTION 'A shift starts open, when it is written' USING ERRCODE = '23514';
  END IF;
  IF NEW.opened_at > now() OR NEW.opened_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'A shift opens from readings taken within the last 24 hours, not later than now' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_memberships WHERE business_id = NEW.business_id AND user_id = NEW.attendant_id AND active) THEN
    RAISE EXCEPTION '% does not work in this business: an attendant is a member of its staff', NEW.attendant_name USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_shifts_insert_check BEFORE INSERT ON fuel_shifts
  FOR EACH ROW EXECUTE FUNCTION fuel_shifts_insert_check();

-- A shift keeps its number, outlet, attendant and opening, and is never
-- deleted; its notes change while it is open. It closes with its close,
-- written in the same moment; a closed shift no longer changes, except when a
-- manager reopens it (its close reopened in the same moment), before another
-- shift opens on any of its nozzles.
CREATE FUNCTION fuel_shifts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD; later RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A shift is never deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'notes', 'updated_by', 'updated_at']) <> (to_jsonb(OLD) - ARRAY['status', 'notes', 'updated_by', 'updated_at']) THEN
    RAISE EXCEPTION 'Shift % keeps its number, outlet, attendant and opening', OLD.shift_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'closed' AND NEW.notes IS DISTINCT FROM OLD.notes THEN
    RAISE EXCEPTION 'Shift % is closed and no longer changes', OLD.shift_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'closed' AND NOT EXISTS (
       SELECT 1 FROM fuel_shift_closes WHERE business_id = NEW.business_id AND shift_id = NEW.id AND reopened_at IS NULL AND created_at = now()) THEN
    RAISE EXCEPTION 'Shift % closes with its closing readings and takings', OLD.shift_no USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW.status = 'open' THEN
    SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND shift_id = NEW.id AND reopened_at = now() ORDER BY seq DESC LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Shift % is closed: a manager reopens it, saying why', OLD.shift_no USING ERRCODE = '23514';
    END IF;
    SELECT s.shift_no, n2.nozzle_no INTO later FROM fuel_shift_nozzles n1
      JOIN fuel_shift_nozzles n2 ON n2.business_id = n1.business_id AND n2.nozzle_id = n1.nozzle_id AND n2.shift_id <> n1.shift_id
      JOIN fuel_shifts s ON s.business_id = n2.business_id AND s.id = n2.shift_id
    WHERE n1.business_id = NEW.business_id AND n1.shift_id = NEW.id AND s.created_at > fc.created_at
    ORDER BY s.created_at LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'Shift % opened on nozzle % after shift % closed: a shift is reopened only before the next one starts', later.shift_no, later.nozzle_no, OLD.shift_no
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_shifts_guard BEFORE UPDATE OR DELETE ON fuel_shifts
  FOR EACH ROW EXECUTE FUNCTION fuel_shifts_guard();

CREATE TABLE fuel_shift_nozzles (
  business_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  nozzle_id BIGINT NOT NULL,
  -- As they were at the opening: the nozzle's number, fuel and tank.
  nozzle_no VARCHAR(10) NOT NULL,
  product_id BIGINT NOT NULL,
  tank_id BIGINT,
  -- Its totaliser when the shift took it on.
  opening NUMERIC(14,3) NOT NULL CHECK (opening >= 0),
  added_by BIGINT NOT NULL REFERENCES users(id),
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, shift_id, nozzle_id),
  FOREIGN KEY (business_id, shift_id) REFERENCES fuel_shifts(business_id, id),
  FOREIGN KEY (business_id, nozzle_id) REFERENCES fuel_nozzles(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  FOREIGN KEY (business_id, tank_id) REFERENCES fuel_tanks(business_id, id)
);
CREATE INDEX fuel_shift_nozzles_nozzle ON fuel_shift_nozzles(business_id, nozzle_id);

-- The open shift a nozzle is on, if any.
CREATE FUNCTION fuel_nozzle_open_shift(target_business BIGINT, target_nozzle BIGINT) RETURNS TABLE (shift_id BIGINT, shift_no VARCHAR, attendant_name VARCHAR)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.shift_no, s.attendant_name FROM fuel_shift_nozzles n JOIN fuel_shifts s ON s.business_id = n.business_id AND s.id = n.shift_id
  WHERE n.business_id = target_business AND n.nozzle_id = target_nozzle AND s.status = 'open' LIMIT 1;
$$;

-- A shift takes a nozzle while it is open: a nozzle in use, of a unit in use,
-- at the shift's outlet, on no other open shift, from its reading now, and
-- not before the last shift on it closed. It keeps its opening reading; a
-- nozzle comes off an open shift only before any close of it.
CREATE FUNCTION fuel_shift_nozzles_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shift RECORD; nozzle RECORD; busy RECORD; latest RECORD; zone TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A shift''s nozzles keep the readings they opened at' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    SELECT shift_no, status INTO shift FROM fuel_shifts WHERE business_id = OLD.business_id AND id = OLD.shift_id;
    IF shift.status <> 'open' OR EXISTS (SELECT 1 FROM fuel_close_readings WHERE business_id = OLD.business_id AND shift_id = OLD.shift_id AND nozzle_id = OLD.nozzle_id) THEN
      RAISE EXCEPTION 'Nozzle % stays on shift %: it was closed on it', OLD.nozzle_no, shift.shift_no USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  SELECT shift_no, status, location_id, opened_at INTO shift FROM fuel_shifts WHERE business_id = NEW.business_id AND id = NEW.shift_id;
  SELECT n.*, d.status AS unit_status, d.unit_no INTO nozzle FROM fuel_nozzles n JOIN fuel_dispensers d ON d.business_id = n.business_id AND d.id = n.dispenser_id
  WHERE n.business_id = NEW.business_id AND n.id = NEW.nozzle_id FOR UPDATE OF n;
  IF shift.status <> 'open' THEN
    RAISE EXCEPTION 'Shift % is closed: open a new shift', shift.shift_no USING ERRCODE = '23514';
  END IF;
  IF nozzle.location_id <> shift.location_id THEN
    RAISE EXCEPTION 'Nozzle % is at another outlet', nozzle.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF NOT nozzle.active THEN
    RAISE EXCEPTION 'Nozzle % is switched off', nozzle.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF nozzle.unit_status <> 'in_use' THEN
    RAISE EXCEPTION 'Dispensing unit % is %: its nozzles are not used until it is back in use', nozzle.unit_no, nozzle.unit_status USING ERRCODE = '23514';
  END IF;
  SELECT * INTO busy FROM fuel_nozzle_open_shift(NEW.business_id, NEW.nozzle_id);
  IF FOUND AND busy.shift_id <> NEW.shift_id THEN
    RAISE EXCEPTION 'Nozzle % is on shift % (%), still open', nozzle.nozzle_no, busy.shift_no, busy.attendant_name USING ERRCODE = '23514';
  END IF;
  IF NEW.opening <> nozzle.reading OR NEW.product_id <> nozzle.product_id OR NEW.tank_id IS DISTINCT FROM nozzle.tank_id OR NEW.nozzle_no <> nozzle.nozzle_no THEN
    RAISE EXCEPTION 'Nozzle % reads % on its totaliser: a shift takes it from there', nozzle.nozzle_no, nozzle.reading USING ERRCODE = '23514';
  END IF;
  SELECT c.closed_at, s.shift_no INTO latest FROM fuel_close_readings r JOIN fuel_shift_closes c ON c.business_id = r.business_id AND c.id = r.close_id
    JOIN fuel_shifts s ON s.business_id = c.business_id AND s.id = c.shift_id
  WHERE r.business_id = NEW.business_id AND r.nozzle_id = NEW.nozzle_id AND c.reopened_at IS NULL ORDER BY c.closed_at DESC LIMIT 1;
  IF FOUND AND shift.opened_at < latest.closed_at THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    RAISE EXCEPTION 'Shift % opens at %, before shift % closed on nozzle % at %', shift.shift_no, fuel_time_words(shift.opened_at, zone), latest.shift_no, nozzle.nozzle_no,
      fuel_time_words(latest.closed_at, zone) USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_shift_nozzles_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_shift_nozzles
  FOR EACH ROW EXECUTE FUNCTION fuel_shift_nozzles_check();

CREATE TABLE fuel_shift_closes (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  -- The first close of the shift, the second (after it was reopened) …
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 100),
  -- When the closing readings were taken.
  closed_at TIMESTAMPTZ NOT NULL,
  -- What the meters sold at the prices in force, on credit slips and to
  -- walk-in buyers; the cash counted and the other takings (UPI, cards, fleet
  -- cards); and the attendant's short (less than zero) or excess.
  expected NUMERIC(16,2) NOT NULL CHECK (expected >= 0),
  credit NUMERIC(16,2) NOT NULL CHECK (credit >= 0),
  walk_in NUMERIC(16,2) NOT NULL CHECK (walk_in >= 0),
  cash NUMERIC(16,2) NOT NULL CHECK (cash >= 0),
  other NUMERIC(16,2) NOT NULL CHECK (other >= 0),
  difference NUMERIC(16,2) NOT NULL,
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  -- The walk-in fuel bill (none when nothing went to walk-in buyers), and its
  -- request key: the bill is posted after this row, and its payments are known by it.
  document_id BIGINT,
  walk_in_key UUID NOT NULL,
  -- Who allowed credit over a vehicle's fill limit or a customer's credit limit.
  approved_by BIGINT REFERENCES users(id),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  closed_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A manager's reopening: when, who and why.
  reopened_at TIMESTAMPTZ,
  reopened_by BIGINT REFERENCES users(id),
  reopen_reason VARCHAR(300) CHECK (btrim(reopen_reason) <> ''),
  reopen_key UUID,
  reopen_hash CHAR(64),
  FOREIGN KEY (business_id, shift_id) REFERENCES fuel_shifts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, shift_id, id),
  UNIQUE (business_id, shift_id, seq),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, walk_in_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, reopen_key),
  CHECK (expected = credit + walk_in),
  CHECK (other <= walk_in),
  CHECK (difference = cash + other - walk_in),
  CHECK (closed_at <= created_at),
  CHECK ((reopened_at IS NULL) = (reopened_by IS NULL)),
  CHECK ((reopened_at IS NULL) = (reopen_reason IS NULL)),
  CHECK ((reopened_at IS NULL) = (reopen_key IS NULL)),
  CHECK ((reopen_key IS NULL) = (reopen_hash IS NULL))
);
-- One close of a shift is in force at a time: the one not reopened.
CREATE UNIQUE INDEX fuel_shift_closes_current ON fuel_shift_closes(business_id, shift_id) WHERE reopened_at IS NULL;
CREATE INDEX fuel_shift_closes_period ON fuel_shift_closes(business_id, closed_at DESC);

-- A close is of an open shift, the next of its closes, from readings taken
-- since it opened, when it is written, not reopened. It keeps what it closed
-- with and is never deleted: its walk-in bill is given once, in the same
-- moment; a manager reopens it once, with a reason.
CREATE FUNCTION fuel_shift_closes_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE shift RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A shift''s close is never deleted: a manager reopens the shift' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT shift_no, status, opened_at INTO shift FROM fuel_shifts WHERE business_id = NEW.business_id AND id = NEW.shift_id FOR UPDATE;
    IF shift.status <> 'open' THEN
      RAISE EXCEPTION 'Shift % is closed already', shift.shift_no USING ERRCODE = '23514';
    END IF;
    IF NEW.created_at <> now() OR NEW.reopened_at IS NOT NULL THEN
      RAISE EXCEPTION 'A shift is closed when it is written' USING ERRCODE = '23514';
    END IF;
    IF NEW.closed_at < shift.opened_at OR NEW.closed_at > now() THEN
      RAISE EXCEPTION 'Shift % closes from readings taken after it opened, not later than now', shift.shift_no USING ERRCODE = '23514';
    END IF;
    IF NEW.seq <> 1 + (SELECT count(*) FROM fuel_shift_closes WHERE business_id = NEW.business_id AND shift_id = NEW.shift_id) THEN
      RAISE EXCEPTION 'Shift %''s closes are numbered in turn', shift.shift_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT shift_no INTO shift FROM fuel_shifts WHERE business_id = NEW.business_id AND id = NEW.shift_id;
  IF OLD.reopened_at IS NOT NULL THEN
    RAISE EXCEPTION 'Shift %''s close was reopened and no longer changes', shift.shift_no USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['document_id', 'reopened_at', 'reopened_by', 'reopen_reason', 'reopen_key', 'reopen_hash'])
     <> (to_jsonb(OLD) - ARRAY['document_id', 'reopened_at', 'reopened_by', 'reopen_reason', 'reopen_key', 'reopen_hash']) THEN
    RAISE EXCEPTION 'Shift % keeps the readings, sales and takings it closed with', shift.shift_no USING ERRCODE = '23514';
  END IF;
  IF NEW.document_id IS DISTINCT FROM OLD.document_id AND (OLD.document_id IS NOT NULL OR OLD.created_at <> now()) THEN
    RAISE EXCEPTION 'Shift %''s walk-in fuel bill is posted once, with its close', shift.shift_no USING ERRCODE = '23514';
  END IF;
  IF NEW.reopened_at IS NOT NULL AND NEW.reopened_at <> now() THEN
    RAISE EXCEPTION 'A shift is reopened when it is written' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_shift_closes_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_shift_closes
  FOR EACH ROW EXECUTE FUNCTION fuel_shift_closes_check();

CREATE TABLE fuel_close_readings (
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  nozzle_id BIGINT NOT NULL,
  -- As the shift took the nozzle: its fuel and tank.
  product_id BIGINT NOT NULL,
  tank_id BIGINT,
  opening NUMERIC(14,3) NOT NULL CHECK (opening >= 0),
  closing NUMERIC(14,3) NOT NULL,
  -- Pumped back into the tank after the nozzle test: not a sale.
  test NUMERIC(10,3) NOT NULL DEFAULT 0 CHECK (test >= 0),
  litres NUMERIC(14,3) NOT NULL CHECK (litres >= 0),
  PRIMARY KEY (business_id, close_id, nozzle_id),
  FOREIGN KEY (business_id, shift_id, close_id) REFERENCES fuel_shift_closes(business_id, shift_id, id),
  FOREIGN KEY (business_id, shift_id, nozzle_id) REFERENCES fuel_shift_nozzles(business_id, shift_id, nozzle_id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  FOREIGN KEY (business_id, tank_id) REFERENCES fuel_tanks(business_id, id),
  CHECK (closing >= opening),
  CHECK (closing - opening <= 1000000),
  CHECK (litres = closing - opening - test)
);
CREATE INDEX fuel_close_readings_nozzle ON fuel_close_readings(business_id, nozzle_id);
CREATE INDEX fuel_close_readings_tank ON fuel_close_readings(business_id, tank_id) WHERE tank_id IS NOT NULL;
CREATE TRIGGER fuel_close_readings_append_only BEFORE UPDATE OR DELETE ON fuel_close_readings
  FOR EACH ROW EXECUTE FUNCTION fuel_append_only();

-- A closing reading is of a nozzle of the shift, from the reading the shift
-- took it at, written with its close.
CREATE FUNCTION fuel_close_readings_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE taken RECORD;
BEGIN
  SELECT * INTO taken FROM fuel_shift_nozzles WHERE business_id = NEW.business_id AND shift_id = NEW.shift_id AND nozzle_id = NEW.nozzle_id;
  IF NEW.opening <> taken.opening OR NEW.product_id <> taken.product_id OR NEW.tank_id IS DISTINCT FROM taken.tank_id THEN
    RAISE EXCEPTION 'Nozzle % opened the shift at %: its close is read from there', taken.nozzle_no, taken.opening USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id AND created_at = now()) THEN
    RAISE EXCEPTION 'A shift''s readings are written with its close' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_close_readings_check BEFORE INSERT ON fuel_close_readings
  FOR EACH ROW EXECUTE FUNCTION fuel_close_readings_check();

CREATE TABLE fuel_close_products (
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  -- The price in force through the shift.
  price NUMERIC(10,2) NOT NULL CHECK (price > 0),
  -- What the meters sold, and of it what went on credit slips and to walk-in buyers.
  litres NUMERIC(14,3) NOT NULL CHECK (litres >= 0),
  credit_litres NUMERIC(14,3) NOT NULL CHECK (credit_litres >= 0),
  walk_in_litres NUMERIC(14,3) NOT NULL CHECK (walk_in_litres >= 0),
  -- The money: each credit slip's litres at the price (to the paisa), and the walk-in litres at it.
  credit_amount NUMERIC(16,2) NOT NULL CHECK (credit_amount >= 0),
  walk_in_amount NUMERIC(16,2) NOT NULL CHECK (walk_in_amount >= 0),
  amount NUMERIC(16,2) NOT NULL,
  -- The walk-in fuel bill's line of it.
  line_id BIGINT,
  PRIMARY KEY (business_id, close_id, product_id),
  FOREIGN KEY (business_id, shift_id, close_id) REFERENCES fuel_shift_closes(business_id, shift_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id),
  CHECK (walk_in_litres = litres - credit_litres),
  CHECK (walk_in_amount = round(walk_in_litres * price, 2)),
  CHECK (amount = credit_amount + walk_in_amount),
  CHECK ((line_id IS NULL) = (walk_in_litres = 0))
);
CREATE INDEX fuel_close_products_product ON fuel_close_products(business_id, product_id);
CREATE TRIGGER fuel_close_products_append_only BEFORE UPDATE OR DELETE ON fuel_close_products
  FOR EACH ROW EXECUTE FUNCTION fuel_append_only();

-- A fuel of a close is written with it; its walk-in line is on the close's
-- walk-in bill, of the fuel's item, for its walk-in litres and money.
CREATE FUNCTION fuel_close_products_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD;
BEGIN
  SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id;
  IF fc.created_at <> now() THEN
    RAISE EXCEPTION 'A shift''s sales are written with its close' USING ERRCODE = '23514';
  END IF;
  IF NEW.line_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = fc.document_id AND f.id = NEW.product_id
         AND l.quantity = NEW.walk_in_litres AND l.net = NEW.walk_in_amount AND l.tax = 0) THEN
    RAISE EXCEPTION 'A fuel''s walk-in sales are a line of the shift''s walk-in fuel bill, for their litres and money' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_close_products_check BEFORE INSERT ON fuel_close_products
  FOR EACH ROW EXECUTE FUNCTION fuel_close_products_check();

CREATE TABLE fuel_credit_slips (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  shift_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 500),
  contact_id BIGINT NOT NULL,
  vehicle_id BIGINT NOT NULL,
  -- The vehicle as it was filled.
  registration VARCHAR(15) NOT NULL,
  product_id BIGINT NOT NULL,
  litres NUMERIC(12,3) NOT NULL CHECK (litres > 0),
  price NUMERIC(10,2) NOT NULL CHECK (price > 0),
  amount NUMERIC(16,2) NOT NULL,
  -- The number of the slip (indent) the driver signed, when there is one.
  slip_no VARCHAR(30) CHECK (btrim(slip_no) <> ''),
  -- Over the vehicle's fill limit, or taking the customer over their credit limit: allowed by the close's approver.
  over_limit BOOLEAN NOT NULL DEFAULT FALSE,
  -- The customer's fuel bill of the shift, and its line of this fill.
  document_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  FOREIGN KEY (business_id, shift_id, close_id) REFERENCES fuel_shift_closes(business_id, shift_id, id),
  FOREIGN KEY (business_id, contact_id, vehicle_id) REFERENCES fuel_vehicles(business_id, contact_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, close_id, seq),
  UNIQUE (business_id, line_id),
  CHECK (amount = round(litres * price, 2))
);
CREATE INDEX fuel_credit_slips_contact ON fuel_credit_slips(business_id, contact_id, close_id);
CREATE INDEX fuel_credit_slips_vehicle ON fuel_credit_slips(business_id, vehicle_id);
CREATE TRIGGER fuel_credit_slips_append_only BEFORE UPDATE OR DELETE ON fuel_credit_slips
  FOR EACH ROW EXECUTE FUNCTION fuel_append_only();

-- A credit fill is written with its close: of a vehicle of the customer in
-- use, the fuel it takes, within its fill limit unless the close's approver
-- allowed more; billed on a line of its own on a fuel bill to that customer,
-- of the fuel's item, for its litres and money.
CREATE FUNCTION fuel_credit_slips_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD; vehicle RECORD;
BEGIN
  SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id;
  IF fc.created_at <> now() THEN
    RAISE EXCEPTION 'A shift''s credit fills are written with its close' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO vehicle FROM fuel_vehicles WHERE business_id = NEW.business_id AND id = NEW.vehicle_id;
  IF NOT vehicle.active OR NEW.registration <> vehicle.registration THEN
    RAISE EXCEPTION 'Vehicle % is not one of the customer''s vehicles in use', NEW.registration USING ERRCODE = '23514';
  END IF;
  IF vehicle.product_id IS NOT NULL AND vehicle.product_id <> NEW.product_id THEN
    RAISE EXCEPTION 'Vehicle % takes another fuel on credit', vehicle.registration USING ERRCODE = '23514';
  END IF;
  IF vehicle.fill_limit IS NOT NULL AND NEW.litres > vehicle.fill_limit AND NOT NEW.over_limit THEN
    RAISE EXCEPTION 'Vehicle % takes at most % litres in a fill on credit', vehicle.registration, vehicle.fill_limit USING ERRCODE = '23514';
  END IF;
  IF NEW.over_limit AND fc.approved_by IS NULL THEN
    RAISE EXCEPTION 'Credit over a limit is allowed by a manager' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM business_document_lines l JOIN business_documents d ON d.business_id = l.business_id AND d.id = l.document_id
       JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = NEW.document_id AND d.kind = 'sale' AND d.contact_id = NEW.contact_id
         AND f.id = NEW.product_id AND l.quantity = NEW.litres AND l.net = NEW.amount AND l.tax = 0) THEN
    RAISE EXCEPTION 'A credit fill is a line of its own on the shift''s fuel bill to the customer, for its litres and money' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_credit_slips_check BEFORE INSERT ON fuel_credit_slips
  FOR EACH ROW EXECUTE FUNCTION fuel_credit_slips_check();

CREATE TABLE fuel_close_payments (
  business_id BIGINT NOT NULL,
  close_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 50),
  -- UPI, a card, or a fleet card (a payment method of the business, with its name as it was).
  method TEXT NOT NULL CHECK (method IN ('upi', 'card', 'bank')),
  method_name VARCHAR(60),
  amount NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  reference VARCHAR(100),
  -- The payment on the walk-in fuel bill.
  payment_id BIGINT NOT NULL,
  PRIMARY KEY (business_id, close_id, seq),
  FOREIGN KEY (business_id, close_id) REFERENCES fuel_shift_closes(business_id, id),
  FOREIGN KEY (business_id, payment_id) REFERENCES business_payments(business_id, id),
  UNIQUE (business_id, payment_id)
);
CREATE TRIGGER fuel_close_payments_append_only BEFORE UPDATE OR DELETE ON fuel_close_payments
  FOR EACH ROW EXECUTE FUNCTION fuel_append_only();

-- A taking is written with its close, paid on its walk-in fuel bill as it was handed in.
CREATE FUNCTION fuel_close_payments_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE fc RECORD;
BEGIN
  SELECT * INTO fc FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.close_id;
  IF fc.created_at <> now() OR NOT EXISTS (
       SELECT 1 FROM business_payments p WHERE p.business_id = NEW.business_id AND p.id = NEW.payment_id AND p.document_id = fc.document_id
         AND p.method = NEW.method AND p.amount = NEW.amount AND p.created_at = now()) THEN
    RAISE EXCEPTION 'A shift''s takings are paid on its walk-in fuel bill as they were handed in, with its close' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_close_payments_check BEFORE INSERT ON fuel_close_payments
  FOR EACH ROW EXECUTE FUNCTION fuel_close_payments_check();

-- When the work is saved (deferred), a close adds up: every nozzle of the
-- shift read; each fuel's litres those of its nozzles, its credit litres and
-- money its slips', at the price in force when the shift opened, with no
-- other price taking effect before it closed; the close's sales, credit,
-- walk-in sales and takings the sums of its own; and its walk-in fuel bill,
-- to no one by name, for the walk-in sales, paid the takings and then the cash
-- counted (no more than is due on it).
CREATE FUNCTION fuel_close_adds_up() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c RECORD; s RECORD; bad RECORD; zone TEXT; cash_paid NUMERIC;
BEGIN
  SELECT * INTO c FROM fuel_shift_closes WHERE business_id = NEW.business_id AND id = NEW.id;
  SELECT * INTO s FROM fuel_shifts WHERE business_id = c.business_id AND id = c.shift_id;
  SELECT n.nozzle_no INTO bad FROM fuel_shift_nozzles n WHERE n.business_id = c.business_id AND n.shift_id = c.shift_id
    AND NOT EXISTS (SELECT 1 FROM fuel_close_readings r WHERE r.business_id = n.business_id AND r.close_id = c.id AND r.nozzle_id = n.nozzle_id) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Shift % closes with a closing reading for nozzle %', s.shift_no, bad.nozzle_no USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM fuel_close_readings r WHERE r.business_id = c.business_id AND r.close_id = c.id
       AND NOT EXISTS (SELECT 1 FROM fuel_close_products p WHERE p.business_id = r.business_id AND p.close_id = r.close_id AND p.product_id = r.product_id))
     OR EXISTS (SELECT 1 FROM fuel_close_products p WHERE p.business_id = c.business_id AND p.close_id = c.id AND (
       p.litres <> (SELECT COALESCE(sum(r.litres), 0) FROM fuel_close_readings r WHERE r.business_id = p.business_id AND r.close_id = p.close_id AND r.product_id = p.product_id)
       OR p.credit_litres <> (SELECT COALESCE(sum(k.litres), 0) FROM fuel_credit_slips k WHERE k.business_id = p.business_id AND k.close_id = p.close_id AND k.product_id = p.product_id)
       OR p.credit_amount <> (SELECT COALESCE(sum(k.amount), 0) FROM fuel_credit_slips k WHERE k.business_id = p.business_id AND k.close_id = p.close_id AND k.product_id = p.product_id)))
     OR EXISTS (SELECT 1 FROM fuel_credit_slips k WHERE k.business_id = c.business_id AND k.close_id = c.id
       AND k.price IS DISTINCT FROM (SELECT p.price FROM fuel_close_products p WHERE p.business_id = k.business_id AND p.close_id = k.close_id AND p.product_id = k.product_id)) THEN
    RAISE EXCEPTION 'Shift %''s sales are its nozzles'' litres, and its credit fills'' litres and money, fuel by fuel', s.shift_no USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = c.business_id;
  SELECT sk.label, p.price, fuel_price_at(c.business_id, s.location_id, p.product_id, s.opened_at) AS in_force,
      (SELECT min(x.effective_from) FROM fuel_prices x WHERE x.business_id = c.business_id AND x.location_id = s.location_id AND x.product_id = p.product_id
         AND x.effective_from > s.opened_at AND x.effective_from < c.closed_at) AS changed_at
    INTO bad
    FROM fuel_close_products p JOIN fuel_products f ON f.business_id = p.business_id AND f.id = p.product_id
    JOIN catalog_skus sk ON sk.business_id = f.business_id AND sk.id = f.sku_id
  WHERE p.business_id = c.business_id AND p.close_id = c.id
    AND (p.price IS DISTINCT FROM fuel_price_at(c.business_id, s.location_id, p.product_id, s.opened_at) OR EXISTS (
      SELECT 1 FROM fuel_prices x WHERE x.business_id = c.business_id AND x.location_id = s.location_id AND x.product_id = p.product_id
        AND x.effective_from > s.opened_at AND x.effective_from < c.closed_at))
  LIMIT 1;
  IF FOUND THEN
    IF bad.changed_at IS NOT NULL THEN
      RAISE EXCEPTION 'The price of % changed at %, while shift % was open: close it with the readings taken then, and open the next shift at the new price',
        bad.label, fuel_time_words(bad.changed_at, zone), s.shift_no USING ERRCODE = '23514';
    END IF;
    RAISE EXCEPTION 'Shift % sells % at the price in force when it opened', s.shift_no, bad.label USING ERRCODE = '23514';
  END IF;
  IF c.expected <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id)
     OR c.credit <> (SELECT COALESCE(sum(amount), 0) FROM fuel_credit_slips WHERE business_id = c.business_id AND close_id = c.id)
     OR c.walk_in <> (SELECT COALESCE(sum(walk_in_amount), 0) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id)
     OR c.other <> (SELECT COALESCE(sum(amount), 0) FROM fuel_close_payments WHERE business_id = c.business_id AND close_id = c.id) THEN
    RAISE EXCEPTION 'Shift %''s close adds up to its sales, its credit fills and its takings', s.shift_no USING ERRCODE = '23514';
  END IF;
  IF (c.document_id IS NULL) <> NOT EXISTS (SELECT 1 FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id AND walk_in_litres > 0) THEN
    RAISE EXCEPTION 'Shift %''s walk-in sales are posted on a walk-in fuel bill', s.shift_no USING ERRCODE = '23514';
  END IF;
  IF c.document_id IS NOT NULL THEN
    cash_paid := COALESCE((SELECT sum(amount) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method = 'cash' AND created_at = c.created_at), 0);
    IF NOT EXISTS (SELECT 1 FROM business_documents d WHERE d.business_id = c.business_id AND d.id = c.document_id AND d.kind = 'sale' AND d.contact_id IS NULL
         AND d.location_id = s.location_id AND d.total = c.walk_in AND d.request_key = c.walk_in_key)
       OR (SELECT count(*) FROM business_document_lines WHERE business_id = c.business_id AND document_id = c.document_id)
          <> (SELECT count(*) FROM fuel_close_products WHERE business_id = c.business_id AND close_id = c.id AND line_id IS NOT NULL)
       OR cash_paid <> LEAST(c.cash, c.walk_in - c.other)
       OR (SELECT COALESCE(sum(amount), 0) FROM business_payments WHERE business_id = c.business_id AND document_id = c.document_id AND method <> 'cash' AND created_at = c.created_at)
          <> c.other THEN
      RAISE EXCEPTION 'Shift %''s walk-in fuel bill is its walk-in sales to no one by name, paid its takings and then the cash counted', s.shift_no USING ERRCODE = '23514';
    END IF;
  ELSIF c.other > 0 THEN
    RAISE EXCEPTION 'Shift % sold nothing to walk-in buyers: it has no UPI, card or fleet-card takings', s.shift_no USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER fuel_shift_closes_adds_up AFTER INSERT ON fuel_shift_closes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fuel_close_adds_up();

-- --- Morning dips ----------------------------------------------------------------------------

CREATE TABLE fuel_dips (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  tank_id BIGINT NOT NULL,
  -- The business's date of the morning dip, and when it was taken.
  dip_on DATE NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL,
  -- The product dip read on the rod (cm), the litres it holds by the tank's
  -- dip chart, the water dip (cm), and the morning density at 15 °C (kg/m³)
  -- and the temperature (°C) of a nozzle sample.
  dip_cm NUMERIC(7,1) CHECK (dip_cm >= 0),
  stock NUMERIC(12,3) NOT NULL CHECK (stock >= 0),
  water_cm NUMERIC(6,1) CHECK (water_cm >= 0),
  density NUMERIC(6,1) CHECK (density BETWEEN 600 AND 1100),
  temperature NUMERIC(4,1) CHECK (temperature BETWEEN -20 AND 70),
  note VARCHAR(300) CHECK (btrim(note) <> ''),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- A manager's correction of what was typed: who, when and why.
  corrected_by BIGINT REFERENCES users(id),
  corrected_at TIMESTAMPTZ,
  correction_reason VARCHAR(300) CHECK (btrim(correction_reason) <> ''),
  FOREIGN KEY (business_id, location_id, tank_id) REFERENCES fuel_tanks(business_id, location_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, tank_id, dip_on),
  UNIQUE (business_id, request_key),
  CHECK ((corrected_at IS NULL) = (corrected_by IS NULL)),
  CHECK ((corrected_at IS NULL) = (correction_reason IS NULL))
);
CREATE INDEX fuel_dips_location ON fuel_dips(business_id, location_id, dip_on DESC);

-- A dip is of a tank in use, taken on its day by the business's clock, not
-- later than now nor more than a week back, of no more than the tank holds,
-- written when it is typed. It keeps its tank and day and is never deleted;
-- what was read changes only as a manager's correction, with a reason.
CREATE FUNCTION fuel_dips_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE zone TEXT; tank RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A dip is never deleted: a manager corrects it' USING ERRCODE = '23514';
  END IF;
  SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
  SELECT tank_no, capacity, active INTO tank FROM fuel_tanks WHERE business_id = NEW.business_id AND id = NEW.tank_id;
  IF TG_OP = 'INSERT' THEN
    IF NOT tank.active THEN
      RAISE EXCEPTION 'Tank % is switched off', tank.tank_no USING ERRCODE = '23514';
    END IF;
    IF NEW.created_at <> now() OR NEW.corrected_at IS NOT NULL THEN
      RAISE EXCEPTION 'A dip is written when it is typed' USING ERRCODE = '23514';
    END IF;
    IF NEW.dip_on < (now() AT TIME ZONE zone)::date - 7 THEN
      RAISE EXCEPTION 'A dip is typed within a week of its day' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.location_id <> OLD.location_id OR NEW.tank_id <> OLD.tank_id OR NEW.dip_on <> OLD.dip_on OR NEW.request_key <> OLD.request_key OR NEW.request_hash <> OLD.request_hash
       OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'A dip keeps its tank and its day' USING ERRCODE = '23514';
    END IF;
    IF NEW.corrected_at IS DISTINCT FROM now() OR NEW.correction_reason IS NULL THEN
      RAISE EXCEPTION 'The dip of tank % on % changes only as a manager''s correction, saying why', tank.tank_no, to_char(OLD.dip_on, 'FMDD Mon YYYY') USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.taken_at > now() OR (NEW.taken_at AT TIME ZONE zone)::date <> NEW.dip_on THEN
    RAISE EXCEPTION 'The dip of % is taken on that day by the business''s clock, not later than now', to_char(NEW.dip_on, 'FMDD Mon YYYY') USING ERRCODE = '23514';
  END IF;
  IF NEW.stock > tank.capacity THEN
    RAISE EXCEPTION 'Tank % holds at most % litres', tank.tank_no, tank.capacity USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_dips_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_dips
  FOR EACH ROW EXECUTE FUNCTION fuel_dips_check();

-- --- Tanker receipts -------------------------------------------------------------------------

CREATE TABLE fuel_receipts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  location_id BIGINT NOT NULL,
  -- The oil company's depot or terminal that sent it, as it was named.
  contact_id BIGINT NOT NULL,
  supplier_name VARCHAR(150) NOT NULL,
  invoice_no VARCHAR(60) NOT NULL CHECK (btrim(invoice_no) <> ''),
  invoice_date DATE NOT NULL,
  -- The tank lorry, as on its plate.
  lorry_no VARCHAR(15) NOT NULL CHECK (lorry_no ~ '^[A-Z0-9]{4,15}$'),
  -- When it was decanted (or sent back).
  received_at TIMESTAMPTZ NOT NULL,
  -- The seals and locks matched the invoice (not checked: none).
  seals_ok BOOLEAN,
  -- Accepted (decanted, a purchase through the core), refused (sent back, with
  -- why), or an accepted load cancelled by a manager (its purchase credited).
  status TEXT NOT NULL CHECK (status IN ('accepted', 'refused', 'cancelled')),
  refuse_reason VARCHAR(300) CHECK (btrim(refuse_reason) <> ''),
  -- A load accepted although a density was outside the tolerance: who allowed it, and why.
  density_approved_by BIGINT REFERENCES users(id),
  density_note VARCHAR(300) CHECK (btrim(density_note) <> ''),
  -- The purchase posted for it.
  document_id BIGINT,
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by BIGINT REFERENCES users(id),
  cancel_reason VARCHAR(300) CHECK (btrim(cancel_reason) <> ''),
  cancel_key UUID,
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, contact_id) REFERENCES business_contacts(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, request_key),
  UNIQUE (business_id, document_id),
  UNIQUE (business_id, cancel_key),
  CHECK ((status = 'refused') = (refuse_reason IS NOT NULL)),
  CHECK ((status = 'refused') = (document_id IS NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_reason IS NULL)),
  CHECK ((cancelled_at IS NULL) = (cancel_key IS NULL)),
  CHECK ((density_approved_by IS NULL) = (density_note IS NULL)),
  CHECK (density_approved_by IS NULL OR status <> 'refused'),
  CHECK (received_at <= created_at)
);
CREATE INDEX fuel_receipts_period ON fuel_receipts(business_id, received_at DESC);
CREATE TRIGGER fuel_receipts_supplier BEFORE INSERT ON fuel_receipts
  FOR EACH ROW EXECUTE FUNCTION business_contact_is_supplier();

-- A load is written when it is typed, accepted or refused, received within the
-- last week; an accepted one with its purchase from the supplier at the
-- outlet, under the invoice's number. It keeps what was received and is never
-- deleted; an accepted load is cancelled once, by a manager, with a reason.
CREATE FUNCTION fuel_receipts_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A tanker receipt is never deleted: a manager cancels it' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('accepted', 'refused') OR NEW.created_at <> now() THEN
      RAISE EXCEPTION 'A tanker load is accepted or refused when it is written' USING ERRCODE = '23514';
    END IF;
    IF NEW.received_at < now() - interval '7 days' THEN
      RAISE EXCEPTION 'A tanker load is written within a week of its decanting' USING ERRCODE = '23514';
    END IF;
    IF NEW.document_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM business_documents WHERE business_id = NEW.business_id AND id = NEW.document_id AND kind = 'purchase'
         AND contact_id = NEW.contact_id AND location_id = NEW.location_id AND supplier_bill_no = NEW.invoice_no) THEN
      RAISE EXCEPTION 'An accepted load is a purchase from its supplier at the outlet, under the invoice''s number' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'accepted' THEN
    RAISE EXCEPTION 'Tanker receipt % is % and no longer changes', OLD.invoice_no, OLD.status USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'cancel_key'])
     <> (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'cancel_key'])
     OR NEW.status <> 'cancelled' OR NEW.cancelled_at <> now() THEN
    RAISE EXCEPTION 'Tanker receipt % keeps what was received: a manager cancels it, saying why', OLD.invoice_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_receipts_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_receipts
  FOR EACH ROW EXECUTE FUNCTION fuel_receipts_check();

CREATE TABLE fuel_receipt_lines (
  business_id BIGINT NOT NULL,
  receipt_id BIGINT NOT NULL,
  seq SMALLINT NOT NULL CHECK (seq BETWEEN 1 AND 20),
  tank_id BIGINT NOT NULL,
  product_id BIGINT NOT NULL,
  -- On the invoice: the litres, what they cost the dealer, and the density at 15 °C (kg/m³).
  invoice_litres NUMERIC(12,3) NOT NULL CHECK (invoice_litres > 0),
  invoice_amount NUMERIC(16,2) NOT NULL CHECK (invoice_amount >= 0),
  invoice_density NUMERIC(6,1) NOT NULL CHECK (invoice_density BETWEEN 600 AND 1100),
  -- The lorry's sample at 15 °C, and the tolerance it was checked against then.
  receipt_density NUMERIC(6,1) NOT NULL CHECK (receipt_density BETWEEN 600 AND 1100),
  tolerance NUMERIC(4,1) NOT NULL CHECK (tolerance > 0),
  -- The tank's dip in litres before and after decanting (sales from it stopped meanwhile).
  dip_before NUMERIC(12,3) CHECK (dip_before >= 0),
  dip_after NUMERIC(12,3) CHECK (dip_after >= 0),
  -- The density at 15 °C after decanting and 50 litres dispensed, when it is checked.
  decant_density NUMERIC(6,1) CHECK (decant_density BETWEEN 600 AND 1100),
  decant_by BIGINT REFERENCES users(id),
  decant_at TIMESTAMPTZ,
  -- The purchase's line of it (an accepted load).
  line_id BIGINT,
  PRIMARY KEY (business_id, receipt_id, seq),
  FOREIGN KEY (business_id, receipt_id) REFERENCES fuel_receipts(business_id, id),
  FOREIGN KEY (business_id, tank_id) REFERENCES fuel_tanks(business_id, id),
  FOREIGN KEY (business_id, product_id) REFERENCES fuel_products(business_id, id),
  FOREIGN KEY (business_id, line_id) REFERENCES business_document_lines(business_id, id),
  UNIQUE (business_id, line_id),
  CHECK ((dip_before IS NULL) = (dip_after IS NULL)),
  CHECK (dip_after IS NULL OR dip_after >= dip_before),
  CHECK ((decant_density IS NULL) = (decant_at IS NULL)),
  CHECK ((decant_at IS NULL) = (decant_by IS NULL))
);
-- A load goes into a tank on one line.
CREATE UNIQUE INDEX fuel_receipt_lines_tank ON fuel_receipt_lines(business_id, receipt_id, tank_id);
CREATE INDEX fuel_receipt_lines_tank_time ON fuel_receipt_lines(business_id, tank_id);

-- A line is written with its load: a tank in use at the load's outlet, of the
-- tank's fuel. An accepted load's line has its dips (no more than the tank
-- holds) and its purchase line, of the fuel's item, for the invoice's litres
-- and value; its density within the tolerance, or a manager accepted it. A
-- refused load's line has no purchase. It keeps what was received; the
-- density after decanting is written once, on an accepted load.
CREATE FUNCTION fuel_receipt_lines_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt RECORD; tank RECORD;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A tanker receipt is never deleted: a manager cancels it' USING ERRCODE = '23514';
  END IF;
  SELECT * INTO receipt FROM fuel_receipts WHERE business_id = NEW.business_id AND id = NEW.receipt_id;
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(NEW) - ARRAY['decant_density', 'decant_by', 'decant_at']) <> (to_jsonb(OLD) - ARRAY['decant_density', 'decant_by', 'decant_at'])
       OR OLD.decant_density IS NOT NULL OR receipt.status <> 'accepted' OR NEW.decant_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'Tanker receipt % keeps what was received; the density after decanting is written once', receipt.invoice_no USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT tank_no, location_id, product_id, capacity, active INTO tank FROM fuel_tanks WHERE business_id = NEW.business_id AND id = NEW.tank_id;
  IF receipt.created_at <> now() THEN
    RAISE EXCEPTION 'A tanker load''s lines are written with it' USING ERRCODE = '23514';
  END IF;
  IF tank.location_id <> receipt.location_id OR NOT tank.active OR tank.product_id <> NEW.product_id THEN
    RAISE EXCEPTION 'Tank % is not a tank in use at the outlet for that fuel', tank.tank_no USING ERRCODE = '23514';
  END IF;
  IF NEW.decant_density IS NOT NULL AND receipt.status <> 'accepted' THEN
    RAISE EXCEPTION 'A refused load is not decanted' USING ERRCODE = '23514';
  END IF;
  IF receipt.status = 'refused' THEN
    IF NEW.line_id IS NOT NULL THEN
      RAISE EXCEPTION 'A refused load is not bought' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.dip_before IS NULL OR NEW.dip_after IS NULL OR NEW.dip_after = NEW.dip_before THEN
    RAISE EXCEPTION 'Tank % is dipped before and after decanting' , tank.tank_no USING ERRCODE = '23514';
  END IF;
  IF NEW.dip_after > tank.capacity THEN
    RAISE EXCEPTION 'Tank % holds at most % litres', tank.tank_no, tank.capacity USING ERRCODE = '23514';
  END IF;
  IF abs(NEW.receipt_density - NEW.invoice_density) > NEW.tolerance AND receipt.density_approved_by IS NULL THEN
    RAISE EXCEPTION 'The load for tank % is % kg/m³ from its invoice''s density, outside the % kg/m³ allowed: refuse it, or a manager accepts it saying why',
      tank.tank_no, abs(NEW.receipt_density - NEW.invoice_density), NEW.tolerance USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM business_document_lines l JOIN fuel_products f ON f.business_id = l.business_id AND f.sku_id = l.sku_id
       WHERE l.business_id = NEW.business_id AND l.id = NEW.line_id AND l.document_id = receipt.document_id AND f.id = NEW.product_id
         AND l.quantity = NEW.invoice_litres AND l.net = NEW.invoice_amount) THEN
    RAISE EXCEPTION 'An accepted load''s line is a line of its purchase, of the fuel, for the invoice''s litres and value' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fuel_receipt_lines_check BEFORE INSERT OR UPDATE OR DELETE ON fuel_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION fuel_receipt_lines_check();

-- --- What only the fuel tools credit ---------------------------------------------------------

-- A shift's fuel bill line is credited only by reopening the shift (its close
-- reopened in the same moment), and a tanker load's purchase line only by
-- cancelling the receipt.
CREATE FUNCTION fuel_line_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sold RECORD; bought RECORD;
BEGIN
  SELECT s.shift_no, c.reopened_at INTO sold FROM (
      SELECT close_id FROM fuel_close_products WHERE business_id = NEW.business_id AND line_id = NEW.line_id
      UNION ALL SELECT close_id FROM fuel_credit_slips WHERE business_id = NEW.business_id AND line_id = NEW.line_id) x
    JOIN fuel_shift_closes c ON c.business_id = NEW.business_id AND c.id = x.close_id
    JOIN fuel_shifts s ON s.business_id = c.business_id AND s.id = c.shift_id;
  IF FOUND AND sold.reopened_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'This line is fuel the meters sold on shift %: it is credited only by a manager reopening the shift', sold.shift_no USING ERRCODE = '23514';
  END IF;
  SELECT r.invoice_no, r.cancelled_at INTO bought FROM fuel_receipt_lines l JOIN fuel_receipts r ON r.business_id = l.business_id AND r.id = l.receipt_id
  WHERE l.business_id = NEW.business_id AND l.line_id = NEW.line_id;
  IF FOUND AND bought.cancelled_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'This line is fuel received on tanker invoice %: it goes back only by a manager cancelling the receipt', bought.invoice_no USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_return_lines_fuel BEFORE INSERT ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION fuel_line_return();

-- --- The cash limit and a shift's walk-in fuel bill ---------------------------------------------

-- The cash limit (migration 1791960001000) as it was, but for a shift's
-- walk-in fuel bill: it is the shift's fills to many buyers, each fill its own
-- transaction, not one bill to one person.
CREATE OR REPLACE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no, d.request_key INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  IF doc.contact_id IS NULL AND EXISTS (SELECT 1 FROM fuel_shift_closes c WHERE c.business_id = NEW.business_id AND c.walk_in_key = doc.request_key) THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
CREATE OR REPLACE FUNCTION business_cash_limit_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  doc RECORD;
  zone TEXT;
  on_bill NUMERIC;
  from_customer NUMERIC;
BEGIN
  IF NEW.method <> 'cash' THEN RETURN NEW; END IF;
  SELECT d.kind, d.contact_id, d.document_no INTO doc FROM business_documents d WHERE d.business_id = NEW.business_id AND d.id = NEW.document_id;
  IF doc.kind IS DISTINCT FROM 'sale' THEN RETURN NEW; END IF;
  SELECT COALESCE(sum(amount), 0) + NEW.amount INTO on_bill FROM business_payments
  WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND method = 'cash';
  IF on_bill >= 200000 THEN
    RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken for one bill (Income-tax Act 2025, section 186): % would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
      doc.document_no, on_bill::NUMERIC(16,2) USING ERRCODE = '23514';
  END IF;
  -- A collection receipt's own cash was counted when the receipt was taken.
  IF doc.contact_id IS NOT NULL AND NEW.collection_id IS NULL THEN
    SELECT timezone INTO zone FROM businesses WHERE id = NEW.business_id;
    from_customer := business_cash_from_customer(NEW.business_id, doc.contact_id, zone, (now() AT TIME ZONE zone)::date) + NEW.amount;
    IF from_customer >= 200000 THEN
      RAISE EXCEPTION 'Cash of ₹2,00,000 or more cannot be taken from one customer in a day (Income-tax Act 2025, section 186): today''s cash from this customer would reach ₹%. Take the rest by UPI, card, bank transfer or cheque.',
        from_customer::NUMERIC(16,2) USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER business_return_lines_fuel ON business_return_lines;
DROP TRIGGER catalog_skus_fuel_item ON catalog_skus;
DROP TABLE fuel_receipt_lines, fuel_receipts, fuel_dips, fuel_close_payments, fuel_credit_slips, fuel_close_products, fuel_close_readings, fuel_shift_closes,
  fuel_shift_nozzles, fuel_shifts, fuel_vehicles, fuel_prices, fuel_measures, fuel_meter_changes, fuel_nozzles, fuel_dispensers, fuel_tanks, fuel_products, fuel_settings;
DROP FUNCTION fuel_line_return();
DROP FUNCTION fuel_receipt_lines_check();
DROP FUNCTION fuel_receipts_check();
DROP FUNCTION fuel_dips_check();
DROP FUNCTION fuel_close_adds_up();
DROP FUNCTION fuel_close_payments_check();
DROP FUNCTION fuel_credit_slips_check();
DROP FUNCTION fuel_close_products_check();
DROP FUNCTION fuel_close_readings_check();
DROP FUNCTION fuel_shift_closes_check();
DROP FUNCTION fuel_shift_nozzles_check();
DROP FUNCTION fuel_shifts_guard();
DROP FUNCTION fuel_shifts_insert_check();
DROP FUNCTION fuel_vehicles_guard();
DROP FUNCTION fuel_prices_check();
DROP FUNCTION fuel_price_at(BIGINT, BIGINT, BIGINT, TIMESTAMPTZ);
DROP FUNCTION fuel_measures_guard();
DROP FUNCTION fuel_meter_changes_check();
DROP FUNCTION fuel_nozzles_guard();
DROP FUNCTION fuel_dispensers_guard();
DROP FUNCTION fuel_nozzle_open_shift(BIGINT, BIGINT);
DROP FUNCTION fuel_tanks_guard();
DROP FUNCTION fuel_item_guard();
DROP FUNCTION fuel_products_guard();
DROP FUNCTION fuel_time_words(TIMESTAMPTZ, TEXT);
DROP FUNCTION fuel_append_only();
DELETE FROM business_number_series WHERE document_kind = 'fuel_shift';
DO $$
DECLARE kinds TEXT[];
BEGIN
  SELECT array_agg(m[1]) INTO kinds FROM regexp_matches(
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'business_number_series_document_kind_check'), '''([a-z_]+)''', 'g') AS m;
  kinds := array_remove(kinds, 'fuel_shift');
  ALTER TABLE business_number_series DROP CONSTRAINT business_number_series_document_kind_check;
  EXECUTE format('ALTER TABLE business_number_series ADD CONSTRAINT business_number_series_document_kind_check CHECK (document_kind IN (%s))',
    (SELECT string_agg(quote_literal(k), ', ') FROM unnest(kinds) k));
END $$;
DELETE FROM business_role_permissions WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'pump_attendant');
UPDATE business_memberships m SET role_id = (SELECT r2.id FROM business_roles r2 WHERE r2.business_id = m.business_id AND r2.template_code = 'viewer')
  WHERE role_id IN (SELECT id FROM business_roles WHERE template_code = 'pump_attendant');
DELETE FROM business_roles WHERE template_code = 'pump_attendant';
DELETE FROM business_role_template_permissions WHERE template_code = 'pump_attendant';
DELETE FROM business_role_templates WHERE code = 'pump_attendant';
DELETE FROM business_capabilities WHERE capability = 'fuel';
DELETE FROM business_role_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'fuel');
DELETE FROM business_role_template_permissions WHERE permission_code IN (SELECT code FROM business_permissions WHERE module_code = 'fuel');
DELETE FROM business_permissions WHERE module_code = 'fuel';
DELETE FROM platform_module_business_types WHERE module_code = 'fuel';
DELETE FROM platform_module_dependencies WHERE module_code = 'fuel';
DELETE FROM platform_modules WHERE code = 'fuel';
