-- Up Migration
-- Shared core: moving stock between locations, and counting it.
--
-- Both write to the same stock ledger (business_stock_movements) as sales,
-- purchases and corrections, so "sum of movements = lot quantity" keeps
-- holding for every lot, whatever happened to it.

-- A transfer leaves the sending location when it is dispatched and arrives
-- when the receiving location confirms it. In between the goods are in
-- transit: counted at neither location, visible on the transfer.
CREATE TABLE business_stock_transfers (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  transfer_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  from_location_id BIGINT NOT NULL,
  to_location_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received', 'cancelled')),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  request_hash CHAR(64) NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(300),
  FOREIGN KEY (business_id, from_location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, to_location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, transfer_no),
  UNIQUE (business_id, request_key),
  CHECK (from_location_id <> to_location_id),
  -- Received and cancelled transfers say who closed them and when.
  CHECK ((status = 'in_transit') = (closed_at IS NULL)),
  CHECK ((status = 'in_transit') = (closed_by IS NULL)),
  CHECK (status <> 'cancelled' OR close_reason IS NOT NULL)
);
CREATE INDEX business_stock_transfers_period ON business_stock_transfers(business_id, created_at DESC);
CREATE INDEX business_stock_transfers_open ON business_stock_transfers(business_id, to_location_id) WHERE status = 'in_transit';

CREATE TABLE business_stock_transfer_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  transfer_id BIGINT NOT NULL,
  sku_id BIGINT NOT NULL,
  -- Snapshot of the sending lot: batch/serial, expiry and cost travel with the goods.
  source_lot_id BIGINT NOT NULL,
  lot_code VARCHAR(100) NOT NULL DEFAULT '',
  expires_on DATE,
  unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity > 0),
  destination_lot_id BIGINT,
  FOREIGN KEY (business_id, transfer_id) REFERENCES business_stock_transfers(business_id, id),
  FOREIGN KEY (business_id, sku_id) REFERENCES catalog_skus(business_id, id),
  FOREIGN KEY (business_id, source_lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, destination_lot_id) REFERENCES business_stock_lots(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (transfer_id, source_lot_id)
);

-- A count sheet for one location: the lots there when it was started, the
-- quantity the system expected then, and what was counted. Approving it
-- compares each count with the quantity at that moment and posts the
-- difference as a reasoned stock correction (business_stock_adjustments).
CREATE TABLE business_stock_counts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL REFERENCES businesses(id),
  count_no VARCHAR(50) NOT NULL,
  series_id BIGINT,
  location_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'posted', 'cancelled')),
  notes VARCHAR(500),
  request_key UUID NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_by BIGINT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(300),
  FOREIGN KEY (business_id, location_id) REFERENCES business_locations(business_id, id),
  FOREIGN KEY (business_id, series_id) REFERENCES business_number_series(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (business_id, count_no),
  UNIQUE (business_id, request_key),
  CHECK ((status = 'open') = (closed_at IS NULL)),
  CHECK ((status = 'open') = (closed_by IS NULL)),
  CHECK (status <> 'cancelled' OR close_reason IS NOT NULL)
);
-- One open count per location: two sheets for the same shelf would post the
-- same difference twice.
CREATE UNIQUE INDEX business_stock_counts_one_open ON business_stock_counts(business_id, location_id) WHERE status = 'open';
CREATE INDEX business_stock_counts_period ON business_stock_counts(business_id, created_at DESC);

CREATE TABLE business_stock_count_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  count_id BIGINT NOT NULL,
  lot_id BIGINT NOT NULL,
  expected_quantity NUMERIC(16,3) NOT NULL CHECK (expected_quantity >= 0),
  counted_quantity NUMERIC(16,3) CHECK (counted_quantity >= 0),
  reason VARCHAR(300),
  -- Filled in on approval: the system quantity at that moment and the
  -- correction posted (counted - system), if any.
  system_quantity NUMERIC(16,3) CHECK (system_quantity >= 0),
  adjustment_id BIGINT,
  counted_by BIGINT REFERENCES users(id),
  counted_at TIMESTAMPTZ,
  FOREIGN KEY (business_id, count_id) REFERENCES business_stock_counts(business_id, id),
  FOREIGN KEY (business_id, lot_id) REFERENCES business_stock_lots(business_id, id),
  FOREIGN KEY (business_id, adjustment_id) REFERENCES business_stock_adjustments(business_id, id),
  UNIQUE (business_id, id),
  UNIQUE (count_id, lot_id),
  CHECK ((counted_quantity IS NULL) = (counted_at IS NULL))
);

-- Corrections made by a count point back at it.
ALTER TABLE business_stock_adjustments ADD COLUMN count_id BIGINT,
  ADD CONSTRAINT business_stock_adjustments_count_fkey FOREIGN KEY (business_id, count_id) REFERENCES business_stock_counts(business_id, id);

-- The ledger gains a fourth kind of source. Exactly one of document,
-- adjustment or transfer explains each movement (a return is a document
-- movement that also names the return).
ALTER TABLE business_stock_movements ADD COLUMN transfer_id BIGINT,
  ADD CONSTRAINT business_stock_movements_transfer_fkey FOREIGN KEY (business_id, transfer_id) REFERENCES business_stock_transfers(business_id, id),
  DROP CONSTRAINT business_stock_movements_check,
  ADD CONSTRAINT business_stock_movements_one_source CHECK (
    num_nonnulls(document_id, adjustment_id, transfer_id) = 1 AND (return_id IS NULL OR document_id IS NOT NULL));
CREATE INDEX business_stock_movements_period ON business_stock_movements(business_id, created_at DESC);

-- Down Migration
DROP INDEX business_stock_movements_period;
ALTER TABLE business_stock_movements DROP CONSTRAINT business_stock_movements_one_source,
  DROP CONSTRAINT business_stock_movements_transfer_fkey, DROP COLUMN transfer_id;
ALTER TABLE business_stock_movements ADD CONSTRAINT business_stock_movements_check CHECK (
  (document_id IS NOT NULL AND adjustment_id IS NULL) OR (document_id IS NULL AND adjustment_id IS NOT NULL AND return_id IS NULL));
ALTER TABLE business_stock_adjustments DROP CONSTRAINT business_stock_adjustments_count_fkey, DROP COLUMN count_id;
DROP TABLE business_stock_count_lines, business_stock_counts, business_stock_transfer_lines, business_stock_transfers;
