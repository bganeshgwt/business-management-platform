-- Up Migration
-- The records the tax law and the books depend on are kept by the database
-- itself, not only by the API's code: a wrong query, a bug or a delete typed
-- into a database tool cannot remove or rewrite them.
--
-- Kept as they were saved (never changed, never deleted): a business's posted
-- documents (bills, invoices, purchases) and their lines, its payments, its
-- stock movements, its returns and their lines, and the three activity logs
-- (a business's, a restaurant's, the platform's). A document line may still
-- take its stock cost and batch, which posting and a later job delivery fill.
-- A payment goes only when the cheque that made it bounces: the cheque keeps
-- what it took back, and the activity log says so.
--
-- Never deleted (they change as a bill is paid or an order is served): a
-- restaurant's orders and their lines, bills and their lines, payments,
-- refunds, credit notes and their lines, cash movements, goods received,
-- supplier payments and purchase returns. A restaurant that has taken an order
-- or made a bill is never deleted either (its status says it is closed).
--
-- Only the login that owns the tables (the one that runs migrations) may
-- rewrite history, and only after asking for it in its own session:
--   SET app.edit_history = 'on';
-- The API's own login never can, even if it asks. Tests ask for it to move a
-- record back in time.

CREATE FUNCTION kept_record_rewrite_allowed(rel REGCLASS) RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.edit_history', true) = 'on'
    AND pg_has_role(session_user, (SELECT relowner FROM pg_class WHERE oid = rel), 'MEMBER')
$$;

-- TG_ARGV[0]: the record in words ("A payment"); TG_ARGV[1], optional: the
-- columns that may still change, comma-separated. A trigger on DELETE (and
-- TRUNCATE) alone keeps the rows; one on UPDATE too keeps every column.
CREATE FUNCTION kept_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  free TEXT[] := CASE WHEN TG_NARGS > 1 THEN string_to_array(TG_ARGV[1], ',') ELSE '{}' END;
BEGIN
  IF kept_record_rewrite_allowed(TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '% is kept for good and is never deleted', TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION '% is kept as it was saved and never changes', TG_ARGV[0] USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- A business's payment: as the guard above, except that the cheque it came
-- from, once bounced, takes it back.
CREATE FUNCTION business_payments_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.collection_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM business_collection_cheques c
         WHERE c.business_id = OLD.business_id AND c.collection_id = OLD.collection_id AND c.status = 'bounced') THEN
      RETURN OLD;
    END IF;
  END IF;
  IF kept_record_rewrite_allowed(TG_RELID) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'A payment is kept for good: only a bounced cheque takes back what it paid' USING ERRCODE = '23514';
  END IF;
  IF to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
    RAISE EXCEPTION 'A payment is kept as it was saved and never changes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION restaurants_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF kept_record_rewrite_allowed(TG_RELID) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM orders WHERE restaurant_id = OLD.id) OR EXISTS (SELECT 1 FROM bills WHERE restaurant_id = OLD.id) THEN
    RAISE EXCEPTION 'Restaurant % has taken orders, so it is never deleted: set it inactive instead', OLD.name USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END $$;

-- Kept as saved.
CREATE TRIGGER business_documents_kept BEFORE UPDATE OR DELETE ON business_documents
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A posted bill, invoice or purchase');
CREATE TRIGGER business_document_lines_kept BEFORE UPDATE OR DELETE ON business_document_lines
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A line of a posted bill', 'stock_unit_cost,lot_code');
CREATE TRIGGER business_payments_kept BEFORE UPDATE OR DELETE ON business_payments
  FOR EACH ROW EXECUTE FUNCTION business_payments_kept();
CREATE TRIGGER business_stock_movements_kept BEFORE UPDATE OR DELETE ON business_stock_movements
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A stock movement');
CREATE TRIGGER business_returns_kept BEFORE UPDATE OR DELETE ON business_returns
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A return');
CREATE TRIGGER business_return_lines_kept BEFORE UPDATE OR DELETE ON business_return_lines
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A line of a return');
CREATE TRIGGER business_audit_kept BEFORE UPDATE OR DELETE ON business_audit
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('An entry in the activity log');
CREATE TRIGGER audit_logs_kept BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('An entry in the activity log');
CREATE TRIGGER platform_audit_kept BEFORE UPDATE OR DELETE ON platform_audit
  FOR EACH ROW EXECUTE FUNCTION kept_record_guard('An entry in the platform''s activity log');

-- Never deleted.
CREATE TRIGGER orders_kept BEFORE DELETE ON orders FOR EACH ROW EXECUTE FUNCTION kept_record_guard('An order');
CREATE TRIGGER order_items_kept BEFORE DELETE ON order_items FOR EACH ROW EXECUTE FUNCTION kept_record_guard('An order line');
CREATE TRIGGER bills_kept BEFORE DELETE ON bills FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A bill');
CREATE TRIGGER bill_items_kept BEFORE DELETE ON bill_items FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A bill line');
CREATE TRIGGER payments_kept BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A payment');
CREATE TRIGGER refunds_kept BEFORE DELETE ON refunds FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A refund');
CREATE TRIGGER credit_notes_kept BEFORE DELETE ON credit_notes FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A credit note');
CREATE TRIGGER credit_note_items_kept BEFORE DELETE ON credit_note_items FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A credit note line');
CREATE TRIGGER cash_movements_kept BEFORE DELETE ON cash_movements FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A cash movement');
CREATE TRIGGER goods_receipts_kept BEFORE DELETE ON goods_receipts FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A goods receipt');
CREATE TRIGGER supplier_payments_kept BEFORE DELETE ON supplier_payments FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A supplier payment');
CREATE TRIGGER purchase_returns_kept BEFORE DELETE ON purchase_returns FOR EACH ROW EXECUTE FUNCTION kept_record_guard('A purchase return');
CREATE TRIGGER restaurants_kept BEFORE DELETE ON restaurants FOR EACH ROW EXECUTE FUNCTION restaurants_kept();

-- TRUNCATE skips row triggers, so each kept table refuses it as well.
CREATE TRIGGER business_documents_kept_truncate BEFORE TRUNCATE ON business_documents FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A posted bill, invoice or purchase');
CREATE TRIGGER business_document_lines_kept_truncate BEFORE TRUNCATE ON business_document_lines FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A line of a posted bill');
CREATE TRIGGER business_payments_kept_truncate BEFORE TRUNCATE ON business_payments FOR EACH STATEMENT EXECUTE FUNCTION business_payments_kept();
CREATE TRIGGER business_stock_movements_kept_truncate BEFORE TRUNCATE ON business_stock_movements FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A stock movement');
CREATE TRIGGER business_returns_kept_truncate BEFORE TRUNCATE ON business_returns FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A return');
CREATE TRIGGER business_return_lines_kept_truncate BEFORE TRUNCATE ON business_return_lines FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A line of a return');
CREATE TRIGGER business_audit_kept_truncate BEFORE TRUNCATE ON business_audit FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('An entry in the activity log');
CREATE TRIGGER audit_logs_kept_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('An entry in the activity log');
CREATE TRIGGER platform_audit_kept_truncate BEFORE TRUNCATE ON platform_audit FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('An entry in the platform''s activity log');
CREATE TRIGGER orders_kept_truncate BEFORE TRUNCATE ON orders FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('An order');
CREATE TRIGGER order_items_kept_truncate BEFORE TRUNCATE ON order_items FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('An order line');
CREATE TRIGGER bills_kept_truncate BEFORE TRUNCATE ON bills FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A bill');
CREATE TRIGGER bill_items_kept_truncate BEFORE TRUNCATE ON bill_items FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A bill line');
CREATE TRIGGER payments_kept_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A payment');
CREATE TRIGGER refunds_kept_truncate BEFORE TRUNCATE ON refunds FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A refund');
CREATE TRIGGER credit_notes_kept_truncate BEFORE TRUNCATE ON credit_notes FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A credit note');
CREATE TRIGGER credit_note_items_kept_truncate BEFORE TRUNCATE ON credit_note_items FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A credit note line');
CREATE TRIGGER cash_movements_kept_truncate BEFORE TRUNCATE ON cash_movements FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A cash movement');
CREATE TRIGGER goods_receipts_kept_truncate BEFORE TRUNCATE ON goods_receipts FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A goods receipt');
CREATE TRIGGER supplier_payments_kept_truncate BEFORE TRUNCATE ON supplier_payments FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A supplier payment');
CREATE TRIGGER purchase_returns_kept_truncate BEFORE TRUNCATE ON purchase_returns FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A purchase return');
CREATE TRIGGER restaurants_kept_truncate BEFORE TRUNCATE ON restaurants FOR EACH STATEMENT EXECUTE FUNCTION kept_record_guard('A restaurant');

-- Down Migration
DROP TRIGGER restaurants_kept_truncate ON restaurants;
DROP TRIGGER purchase_returns_kept_truncate ON purchase_returns;
DROP TRIGGER supplier_payments_kept_truncate ON supplier_payments;
DROP TRIGGER goods_receipts_kept_truncate ON goods_receipts;
DROP TRIGGER cash_movements_kept_truncate ON cash_movements;
DROP TRIGGER credit_note_items_kept_truncate ON credit_note_items;
DROP TRIGGER credit_notes_kept_truncate ON credit_notes;
DROP TRIGGER refunds_kept_truncate ON refunds;
DROP TRIGGER payments_kept_truncate ON payments;
DROP TRIGGER bill_items_kept_truncate ON bill_items;
DROP TRIGGER bills_kept_truncate ON bills;
DROP TRIGGER order_items_kept_truncate ON order_items;
DROP TRIGGER orders_kept_truncate ON orders;
DROP TRIGGER platform_audit_kept_truncate ON platform_audit;
DROP TRIGGER audit_logs_kept_truncate ON audit_logs;
DROP TRIGGER business_audit_kept_truncate ON business_audit;
DROP TRIGGER business_return_lines_kept_truncate ON business_return_lines;
DROP TRIGGER business_returns_kept_truncate ON business_returns;
DROP TRIGGER business_stock_movements_kept_truncate ON business_stock_movements;
DROP TRIGGER business_payments_kept_truncate ON business_payments;
DROP TRIGGER business_document_lines_kept_truncate ON business_document_lines;
DROP TRIGGER business_documents_kept_truncate ON business_documents;
DROP TRIGGER restaurants_kept ON restaurants;
DROP TRIGGER purchase_returns_kept ON purchase_returns;
DROP TRIGGER supplier_payments_kept ON supplier_payments;
DROP TRIGGER goods_receipts_kept ON goods_receipts;
DROP TRIGGER cash_movements_kept ON cash_movements;
DROP TRIGGER credit_note_items_kept ON credit_note_items;
DROP TRIGGER credit_notes_kept ON credit_notes;
DROP TRIGGER refunds_kept ON refunds;
DROP TRIGGER payments_kept ON payments;
DROP TRIGGER bill_items_kept ON bill_items;
DROP TRIGGER bills_kept ON bills;
DROP TRIGGER order_items_kept ON order_items;
DROP TRIGGER orders_kept ON orders;
DROP TRIGGER platform_audit_kept ON platform_audit;
DROP TRIGGER audit_logs_kept ON audit_logs;
DROP TRIGGER business_audit_kept ON business_audit;
DROP TRIGGER business_return_lines_kept ON business_return_lines;
DROP TRIGGER business_returns_kept ON business_returns;
DROP TRIGGER business_stock_movements_kept ON business_stock_movements;
DROP TRIGGER business_payments_kept ON business_payments;
DROP TRIGGER business_document_lines_kept ON business_document_lines;
DROP TRIGGER business_documents_kept ON business_documents;
DROP FUNCTION restaurants_kept();
DROP FUNCTION business_payments_kept();
DROP FUNCTION kept_record_guard();
DROP FUNCTION kept_record_rewrite_allowed(REGCLASS);
