-- Up Migration

-- A finished dish written off by its recipe (sweep SW-B-22).
--
-- A plate dropped at the pass, a dish made twice and billed once, the night's
-- leftover biryani: none reaches a bill, so none takes its ingredients out of
-- stock, and each turned up weeks later as "unexplained" at the stock count —
-- unless someone wrote it off ingredient by ingredient. Now one entry says
-- "2 × Paneer Butter Masala, remade" and its recipe (sub-recipes, the size
-- chosen and any add-ons included) comes out of the outlet's store at cost,
-- as ordinary wastage rows that point back at this entry. So it adds up on
-- Waste & reorder, in the stock consumption report and in P&L wastage like
-- any other waste, and a manager can undo it within the week.
CREATE TABLE dish_waste_entries (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id      BIGINT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  -- The outlet it happened at; the stock comes off that outlet's own store
  -- when it keeps one, else the main store (the usual stock rule).
  outlet_id          BIGINT REFERENCES outlets(id),
  product_id         BIGINT NOT NULL REFERENCES products(id),
  product_variant_id BIGINT REFERENCES product_variants(id),
  -- The dish and size as they were called that day.
  item_name          VARCHAR(200) NOT NULL,
  quantity           INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 500),
  reason             VARCHAR(20) NOT NULL CHECK (reason IN ('dropped', 'remade', 'spoiled', 'quality')),
  note               VARCHAR(300),
  -- Add-ons that went with it ([{ modifierId, name }]), for the record.
  addons             JSONB NOT NULL DEFAULT '[]'::jsonb,
  value              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (value >= 0),
  ingredient_lines   INTEGER NOT NULL DEFAULT 0,
  waste_date         DATE NOT NULL,
  reversed_at        TIMESTAMPTZ,
  reversed_by        BIGINT REFERENCES users(id),
  reversal_note      VARCHAR(300),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by         BIGINT REFERENCES users(id)
);

CREATE INDEX idx_dish_waste_entries_restaurant ON dish_waste_entries (restaurant_id, waste_date DESC, id DESC);

-- Down Migration

DROP TABLE IF EXISTS dish_waste_entries;
