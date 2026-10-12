-- Up Migration

-- ===========================================================================
-- Bill numbers that stay unique when outlets bill at the same moment, the
-- buyer's address on a B2B invoice, and guest / company accounts (dues).
-- ===========================================================================

-- --- One counter per invoice series ------------------------------------------
-- Each outlet used to count its own bills (BILL:<outlet>) but an outlet with
-- no invoice prefix of its own printed the restaurant's prefix, so two
-- counters handed out RC-0042 at the same moment and the second bill failed
-- with "Internal server error". A counter now belongs to the series it
-- numbers ("BILL:RC", "BILL:RC-BR"): whatever outlets share a prefix share
-- one locked counter, and a number can never be handed out twice. The key
-- carries the whole prefix, so the column is widened.
ALTER TABLE document_counters ALTER COLUMN series TYPE VARCHAR(40);

-- Every series already on a bill carries on from its highest number. A bill
-- number is "<prefix>-<digits>"; the old per-outlet counters are left where
-- they are (nothing reads them any more).
INSERT INTO document_counters (restaurant_id, series, last_number)
SELECT b.restaurant_id,
       'BILL:' || SUBSTRING(b.bill_number FROM '^(.*)-[0-9]+$'),
       MAX(SUBSTRING(b.bill_number FROM '-([0-9]+)$')::bigint)::int
FROM bills b
WHERE b.bill_number ~ '^.+-[0-9]+$'
  AND LENGTH(SUBSTRING(b.bill_number FROM '^(.*)-[0-9]+$')) <= 35
GROUP BY b.restaurant_id, SUBSTRING(b.bill_number FROM '^(.*)-[0-9]+$')
ON CONFLICT (restaurant_id, series)
DO UPDATE SET last_number = GREATEST(document_counters.last_number, EXCLUDED.last_number);

-- --- The buyer's address on a B2B invoice ---------------------------------------
-- A tax invoice to a registered buyer carries the buyer's name, GSTIN and
-- address (Rule 46). The GSTIN gives the state; the address is typed at the
-- till when the guest asks for a company invoice.
ALTER TABLE bill_gst_recipients ADD COLUMN address TEXT;

-- --- Guest and company accounts (dues) ------------------------------------------
-- A regular or a company that settles monthly: a bill is put on their account
-- instead of being paid, up to a credit limit the owner sets. Kept apart from
-- the guest book (customers): the guest book is everyone who ever ate here,
-- an account is a decision to give someone credit.
CREATE TABLE customer_accounts (
  id             BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id  BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  customer_id    BIGINT        NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  -- The most the account may owe at once. A bill that would take it past this
  -- is refused at the till; the owner raises the limit here instead.
  credit_limit   NUMERIC(12,2) NOT NULL CHECK (credit_limit >= 0),
  -- The days the guest is given to pay; dues older than this are overdue.
  credit_days    INTEGER       NOT NULL DEFAULT 30 CHECK (credit_days BETWEEN 0 AND 365),
  status         VARCHAR(20)   NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'on_hold')),
  notes          VARCHAR(300),
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by     BIGINT        REFERENCES users(id),
  updated_by     BIGINT        REFERENCES users(id),
  UNIQUE (restaurant_id, customer_id)
);

CREATE TRIGGER trg_customer_accounts_updated_at
BEFORE UPDATE ON customer_accounts
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A bill put on an account stays a bill with money due (unpaid or part paid);
-- what changes is who owes it. Who put it there, and the manager who allowed
-- it, are kept on the bill as well as in the activity log.
ALTER TABLE bills
  ADD COLUMN account_customer_id  BIGINT REFERENCES customers(id),
  ADD COLUMN account_at           TIMESTAMPTZ,
  ADD COLUMN account_by           BIGINT REFERENCES users(id),
  ADD COLUMN account_approved_by  BIGINT REFERENCES users(id),
  ADD COLUMN account_note         VARCHAR(200);

-- The dues list and a statement read one account's bills.
CREATE INDEX idx_bills_account
  ON bills (restaurant_id, account_customer_id)
  WHERE account_customer_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_bills_account;

ALTER TABLE bills
  DROP COLUMN IF EXISTS account_note,
  DROP COLUMN IF EXISTS account_approved_by,
  DROP COLUMN IF EXISTS account_by,
  DROP COLUMN IF EXISTS account_at,
  DROP COLUMN IF EXISTS account_customer_id;

DROP TABLE IF EXISTS customer_accounts;

ALTER TABLE bill_gst_recipients DROP COLUMN IF EXISTS address;

DELETE FROM document_counters WHERE LENGTH(series) > 10;
ALTER TABLE document_counters ALTER COLUMN series TYPE VARCHAR(10);
