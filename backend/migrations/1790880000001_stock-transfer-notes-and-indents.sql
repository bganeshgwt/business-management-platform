-- Up Migration

-- Stock moving between stores as a document (sweep SW-B-11).
--
-- Moving stock used to be one item per call, landing at once. A main store
-- sending the evening's supplies to two branches sends one note with twenty
-- lines on it, a driver carries it, and the branch checks what came off the
-- van against it. So:
--
--   stock_indents        an outlet asking the main store (or another store)
--                        for stock: items and quantities, with how much has
--                        been sent against each line so far
--   stock_transfers      one delivery challan: from one store to another,
--                        numbered TRF-0001, valued at cost when it left
--   stock_transfer_lines what was sent, and — once the receiving store has
--                        checked it — what arrived, and why any was short
--
-- A store is an outlet that keeps its own stock; NULL is the main store.
--
-- In one-step mode (the default) a note is received the moment it is sent,
-- exactly as before. With "the receiving store confirms" switched on
-- (stock_settings.transfer_receipt_required) the stock leaves the sender at
-- dispatch and the note stays "in transit" until the receiver confirms; only
-- then does stock land on their shelf. Anything short or damaged is written
-- off at the receiving store as wastage, with the reason given and the note
-- named, so it shows in every waste and stock report instead of vanishing.

CREATE TABLE stock_indents (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  indent_number    VARCHAR(30) NOT NULL,
  -- The store asking for stock (an outlet with its own store), and the store
  -- asked (NULL = the main store).
  outlet_id        BIGINT NOT NULL REFERENCES outlets(id),
  supply_outlet_id BIGINT REFERENCES outlets(id),
  needed_by        DATE,
  indent_status    VARCHAR(20) NOT NULL DEFAULT 'requested'
                   CHECK (indent_status IN ('requested', 'part_sent', 'sent', 'closed', 'cancelled')),
  notes            VARCHAR(500),
  closed_reason    VARCHAR(200),
  closed_at        TIMESTAMPTZ,
  closed_by        BIGINT REFERENCES users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       BIGINT REFERENCES users(id),
  updated_by       BIGINT REFERENCES users(id),
  UNIQUE (restaurant_id, indent_number),
  CHECK (supply_outlet_id IS DISTINCT FROM outlet_id)
);

CREATE INDEX idx_stock_indents_open
  ON stock_indents (restaurant_id, created_at DESC)
  WHERE indent_status IN ('requested', 'part_sent');

CREATE TRIGGER trg_stock_indents_updated_at
BEFORE UPDATE ON stock_indents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_indent_lines (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  indent_id         BIGINT NOT NULL REFERENCES stock_indents(id) ON DELETE CASCADE,
  inventory_item_id BIGINT NOT NULL REFERENCES inventory_items(id),
  quantity          NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  -- Sent against this line so far (on its way or arrived), and arrived.
  sent_quantity     NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (sent_quantity >= 0),
  received_quantity NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (received_quantity >= 0),
  note              VARCHAR(200),
  UNIQUE (indent_id, inventory_item_id)
);

CREATE TABLE stock_transfers (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id    BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  transfer_number  VARCHAR(30) NOT NULL,
  from_outlet_id   BIGINT REFERENCES outlets(id),
  to_outlet_id     BIGINT REFERENCES outlets(id),
  indent_id        BIGINT REFERENCES stock_indents(id),
  -- The trading day it was sent on.
  transfer_date    DATE NOT NULL,
  transfer_status  VARCHAR(20) NOT NULL
                   CHECK (transfer_status IN ('in_transit', 'received', 'cancelled')),
  two_step         BOOLEAN NOT NULL DEFAULT FALSE,
  -- At cost when it left; what arrived; what was written off on arrival.
  sent_value       NUMERIC(14,2) NOT NULL DEFAULT 0,
  received_value   NUMERIC(14,2),
  shortfall_value  NUMERIC(14,2),
  vehicle          VARCHAR(60),
  notes            VARCHAR(500),
  dispatched_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_by    BIGINT REFERENCES users(id),
  received_at      TIMESTAMPTZ,
  received_by      BIGINT REFERENCES users(id),
  receipt_note     VARCHAR(500),
  cancelled_at     TIMESTAMPTZ,
  cancelled_by     BIGINT REFERENCES users(id),
  cancel_reason    VARCHAR(200),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by       BIGINT REFERENCES users(id),
  updated_by       BIGINT REFERENCES users(id),
  UNIQUE (restaurant_id, transfer_number),
  CHECK (from_outlet_id IS DISTINCT FROM to_outlet_id)
);

CREATE INDEX idx_stock_transfers_restaurant ON stock_transfers (restaurant_id, dispatched_at DESC);
CREATE INDEX idx_stock_transfers_in_transit
  ON stock_transfers (restaurant_id, to_outlet_id)
  WHERE transfer_status = 'in_transit';
CREATE INDEX idx_stock_transfers_indent ON stock_transfers (indent_id) WHERE indent_id IS NOT NULL;

CREATE TRIGGER trg_stock_transfers_updated_at
BEFORE UPDATE ON stock_transfers
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_transfer_lines (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id        BIGINT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  inventory_item_id  BIGINT NOT NULL REFERENCES inventory_items(id),
  indent_line_id     BIGINT REFERENCES stock_indent_lines(id),
  quantity           NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  -- The item's average cost at dispatch, to the ledger's eight places.
  unit_cost          NUMERIC(18,8),
  value              NUMERIC(14,2) NOT NULL DEFAULT 0,
  received_quantity  NUMERIC(14,3) CHECK (received_quantity IS NULL OR received_quantity >= 0),
  shortfall_quantity NUMERIC(14,3) CHECK (shortfall_quantity IS NULL OR shortfall_quantity >= 0),
  shortfall_reason   VARCHAR(20) CHECK (shortfall_reason IS NULL OR shortfall_reason IN ('short', 'damaged', 'spoiled')),
  shortfall_note     VARCHAR(200),
  -- The batches that left the sending store (first to expire first), so the
  -- same batches land at the receiving store, whenever that is.
  batch_allocations  JSONB,
  out_transaction_id BIGINT REFERENCES stock_transactions(id),
  in_transaction_id  BIGINT REFERENCES stock_transactions(id),
  UNIQUE (transfer_id, inventory_item_id)
);

CREATE INDEX idx_stock_transfer_lines_item ON stock_transfer_lines (inventory_item_id);

-- Down Migration

DROP TABLE IF EXISTS stock_transfer_lines;
DROP TABLE IF EXISTS stock_transfers;
DROP TABLE IF EXISTS stock_indent_lines;
DROP TABLE IF EXISTS stock_indents;
