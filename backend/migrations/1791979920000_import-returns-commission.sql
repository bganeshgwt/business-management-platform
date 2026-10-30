-- Up Migration
-- Free goods on a wholesale return, and a mechanic's commission taken back
-- when the labour it was earned on is credited. (The shops' spreadsheet
-- import of styles with their variants, pack sizes and Excel files needs no
-- table of its own: it makes items, variants and pack sizes through the core.)
--
--   wholesale_free_goods_kept
--                   the free goods (a scheme's, or given by hand) that came with
--                   paid goods on a dispatched order's invoice and that the
--                   customer kept when the paid goods came back: what belongs to
--                   the paid goods returned (in proportion, to the thousandth of
--                   the free goods' unit) and did not come back is charged, its
--                   value before GST and the GST at the paid line's rate coming
--                   off the credit note, as a line of its own.
--                   Free goods brought back after being kept give that back (a
--                   row of less than nothing). Each row is checked against what
--                   belongs to the paid goods returned so far: never more is kept
--                   than belongs, and nothing is given back twice. Never changed.
--   garage_commissions.document_line_id, .line_net
--                   the bill line that carries the labour a commission was earned
--                   on, and that labour line's whole value billed (before GST).
--                   Commission earned before they were kept has neither, and
--                   none of it is taken back.
--   garage_commission_reversals
--                   commission taken back when the bill line that carried the
--                   labour is credited (a return, or a credit by value): in
--                   proportion to the labour credited, to the paisa, dated the
--                   credit's day. It comes off what the mechanic is due; a payout
--                   already made stays. Never changed.

-- --- Free goods kept on a credit note ------------------------------------------------------------

CREATE TABLE wholesale_free_goods_kept (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  return_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  -- The paid order line the free goods came with, and the free order line they are on.
  order_line_id BIGINT NOT NULL,
  free_line_id BIGINT NOT NULL,
  -- Kept (charged) when more than nothing; brought back after being kept (given back) when less.
  quantity NUMERIC(16,3) NOT NULL CHECK (quantity <> 0),
  -- One unit's value before GST, what the change comes to, and its GST at the paid line's rate.
  unit_value NUMERIC(14,4) NOT NULL CHECK (unit_value >= 0),
  net NUMERIC(16,2) NOT NULL,
  tax NUMERIC(16,2) NOT NULL,
  tax_rate NUMERIC(5,2) NOT NULL CHECK (tax_rate >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (business_id, document_id) REFERENCES business_documents(business_id, id),
  FOREIGN KEY (business_id, order_line_id) REFERENCES wholesale_order_lines(business_id, id),
  FOREIGN KEY (business_id, free_line_id) REFERENCES wholesale_order_lines(business_id, id),
  UNIQUE (business_id, return_id, free_line_id),
  -- What a change comes to has the sign of the change.
  CHECK (sign(net) * sign(quantity) >= 0 AND sign(tax) * sign(quantity) >= 0)
);
CREATE INDEX wholesale_free_goods_kept_document ON wholesale_free_goods_kept(business_id, document_id, free_line_id);

-- Free goods kept are those of a paid line on this invoice, never more than
-- belong to its paid goods returned so far (free × paid returned ÷ paid
-- bought, in the free goods' unit to the thousandth, as quantities are kept)
-- and did not come back, and never given back below nothing. The return's own
-- lines are in before its row.
CREATE FUNCTION wholesale_free_goods_kept_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid NUMERIC; paid_back NUMERIC; free NUMERIC; free_back NUMERIC; belongs NUMERIC; kept NUMERIC;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM wholesale_order_lines WHERE business_id = NEW.business_id AND id = NEW.free_line_id AND free_of_line_id = NEW.order_line_id)
     OR NOT EXISTS (SELECT 1 FROM business_returns WHERE business_id = NEW.business_id AND id = NEW.return_id AND document_id = NEW.document_id) THEN
    RAISE EXCEPTION 'Free goods kept on a credit note are the free goods of a paid line on its invoice' USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(sum(bl.quantity), 0),
         COALESCE(sum((SELECT COALESCE(sum(rl.quantity), 0) FROM business_return_lines rl WHERE rl.business_id = bl.business_id AND rl.line_id = bl.id)), 0)
    INTO paid, paid_back
    FROM wholesale_dispatches w
    JOIN wholesale_dispatch_lines dl ON dl.business_id = w.business_id AND dl.dispatch_id = w.id
    JOIN business_document_lines bl ON bl.business_id = dl.business_id AND bl.id = dl.document_line_id
    WHERE w.business_id = NEW.business_id AND w.document_id = NEW.document_id AND dl.order_line_id = NEW.order_line_id;
  SELECT COALESCE(sum(bl.quantity), 0),
         COALESCE(sum((SELECT COALESCE(sum(rl.quantity), 0) FROM business_return_lines rl WHERE rl.business_id = bl.business_id AND rl.line_id = bl.id)), 0)
    INTO free, free_back
    FROM wholesale_dispatches w
    JOIN wholesale_dispatch_lines dl ON dl.business_id = w.business_id AND dl.dispatch_id = w.id
    JOIN business_document_lines bl ON bl.business_id = dl.business_id AND bl.id = dl.document_line_id
    WHERE w.business_id = NEW.business_id AND w.document_id = NEW.document_id AND dl.order_line_id = NEW.free_line_id;
  IF paid <= 0 OR free <= 0 THEN
    RAISE EXCEPTION 'Free goods kept on a credit note are the free goods of a paid line on its invoice' USING ERRCODE = '23514';
  END IF;
  belongs := round(free * LEAST(paid_back, paid) / paid, 3);
  SELECT COALESCE(sum(quantity), 0) + NEW.quantity INTO kept FROM wholesale_free_goods_kept
    WHERE business_id = NEW.business_id AND document_id = NEW.document_id AND free_line_id = NEW.free_line_id;
  IF kept < 0 THEN
    RAISE EXCEPTION 'More free goods would be given back than were kept on this invoice' USING ERRCODE = '23514';
  END IF;
  IF kept > GREATEST(0, belongs - free_back) THEN
    RAISE EXCEPTION 'Free goods kept are never more than belong to the paid goods returned and did not come back (%)', trim_scale(GREATEST(0, belongs - free_back))
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER wholesale_free_goods_kept_check BEFORE INSERT ON wholesale_free_goods_kept
  FOR EACH ROW EXECUTE FUNCTION wholesale_free_goods_kept_check();

CREATE FUNCTION wholesale_free_goods_kept_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Free goods kept on a credit note are kept as they were charged' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER wholesale_free_goods_kept_fixed BEFORE UPDATE OR DELETE ON wholesale_free_goods_kept
  FOR EACH ROW EXECUTE FUNCTION wholesale_free_goods_kept_fixed();

-- --- A mechanic's commission taken back -------------------------------------------------------------

ALTER TABLE garage_commissions ADD COLUMN document_line_id BIGINT, ADD COLUMN line_net NUMERIC(16,2) CHECK (line_net >= 0),
  ADD CONSTRAINT garage_commissions_document_line_fkey FOREIGN KEY (business_id, document_line_id) REFERENCES business_document_lines(business_id, id),
  ADD CONSTRAINT garage_commissions_tenant_id UNIQUE (business_id, id);
CREATE INDEX garage_commissions_document_line ON garage_commissions(business_id, document_line_id) WHERE document_line_id IS NOT NULL;

CREATE TABLE garage_commission_reversals (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_id BIGINT NOT NULL,
  commission_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL REFERENCES users(id),
  -- The credit note, and the bill line it credited.
  return_id BIGINT NOT NULL,
  line_id BIGINT NOT NULL,
  -- The labour credited (the mechanic's part, before GST) and the commission taken back.
  base NUMERIC(16,2) NOT NULL CHECK (base >= 0),
  amount NUMERIC(16,2) NOT NULL CHECK (amount >= 0),
  reversed_on DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, commission_id) REFERENCES garage_commissions(business_id, id),
  FOREIGN KEY (business_id, return_id) REFERENCES business_returns(business_id, id),
  FOREIGN KEY (return_id, line_id) REFERENCES business_return_lines(return_id, line_id),
  UNIQUE (commission_id, return_id),
  CHECK (base > 0 OR amount > 0)
);
CREATE INDEX garage_commission_reversals_person ON garage_commission_reversals(business_id, user_id, reversed_on);

CREATE FUNCTION garage_commission_reversals_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Commission taken back is kept as it was worked out' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER garage_commission_reversals_kept BEFORE UPDATE OR DELETE ON garage_commission_reversals
  FOR EACH ROW EXECUTE FUNCTION garage_commission_reversals_kept();

-- Down Migration
DROP TABLE garage_commission_reversals;
DROP FUNCTION garage_commission_reversals_kept();
DROP INDEX garage_commissions_document_line;
ALTER TABLE garage_commissions DROP CONSTRAINT garage_commissions_tenant_id, DROP CONSTRAINT garage_commissions_document_line_fkey,
  DROP COLUMN line_net, DROP COLUMN document_line_id;
DROP TABLE wholesale_free_goods_kept;
DROP FUNCTION wholesale_free_goods_kept_fixed();
DROP FUNCTION wholesale_free_goods_kept_check();
