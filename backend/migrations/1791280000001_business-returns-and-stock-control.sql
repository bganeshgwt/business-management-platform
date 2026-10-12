-- Up Migration
ALTER TABLE business_document_lines ADD COLUMN stock_unit_cost NUMERIC(14,4) CHECK(stock_unit_cost>=0);
CREATE TABLE business_returns (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 document_id BIGINT NOT NULL,
 reason VARCHAR(300) NOT NULL,
 total NUMERIC(16,2) NOT NULL CHECK(total>=0),
 request_key UUID NOT NULL,
 request_hash CHAR(64) NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,document_id) REFERENCES business_documents(business_id,id),
 UNIQUE(business_id,id), UNIQUE(business_id,request_key)
);
ALTER TABLE business_document_lines ADD CONSTRAINT business_document_lines_tenant_id UNIQUE(business_id,id);
CREATE TABLE business_return_lines (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 return_id BIGINT NOT NULL,
 line_id BIGINT NOT NULL,
 quantity NUMERIC(16,3) NOT NULL CHECK(quantity>0),
 net NUMERIC(16,2) NOT NULL CHECK(net>=0),
 tax NUMERIC(16,2) NOT NULL CHECK(tax>=0),
 restock BOOLEAN NOT NULL,
 FOREIGN KEY(business_id,return_id) REFERENCES business_returns(business_id,id),
 FOREIGN KEY(business_id,line_id) REFERENCES business_document_lines(business_id,id),
 UNIQUE(return_id,line_id)
);
CREATE TABLE business_refunds (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 document_id BIGINT NOT NULL,
 amount NUMERIC(16,2) NOT NULL CHECK(amount>0),
 method TEXT NOT NULL CHECK(method IN ('cash','card','upi','bank')),
 reason VARCHAR(300) NOT NULL,
 request_key UUID NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,document_id) REFERENCES business_documents(business_id,id),
 UNIQUE(business_id,request_key)
);
CREATE TABLE business_stock_adjustments (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 business_id BIGINT NOT NULL,
 lot_id BIGINT NOT NULL,
 quantity NUMERIC(16,3) NOT NULL CHECK(quantity<>0),
 reason VARCHAR(300) NOT NULL,
 request_key UUID NOT NULL,
 created_by BIGINT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(business_id,lot_id) REFERENCES business_stock_lots(business_id,id),
 UNIQUE(business_id,id), UNIQUE(business_id,request_key)
);
ALTER TABLE business_stock_movements ALTER COLUMN document_id DROP NOT NULL;
ALTER TABLE business_stock_movements ADD COLUMN adjustment_id BIGINT;
ALTER TABLE business_stock_movements ADD COLUMN return_id BIGINT;
ALTER TABLE business_stock_movements ADD FOREIGN KEY(business_id,adjustment_id) REFERENCES business_stock_adjustments(business_id,id);
ALTER TABLE business_stock_movements ADD FOREIGN KEY(business_id,return_id) REFERENCES business_returns(business_id,id);
ALTER TABLE business_stock_movements ADD CHECK((document_id IS NOT NULL AND adjustment_id IS NULL) OR (document_id IS NULL AND adjustment_id IS NOT NULL AND return_id IS NULL));
CREATE INDEX business_documents_period ON business_documents(business_id,created_at);
CREATE INDEX business_payments_document ON business_payments(business_id,document_id);
CREATE INDEX business_returns_document ON business_returns(business_id,document_id);
CREATE INDEX business_stock_movements_lot ON business_stock_movements(business_id,lot_id,created_at);

-- Down Migration
-- Operational records must be preserved; reverse this migration only on an
-- empty development schema. PostgreSQL refuses to make document_id NOT NULL
-- while adjustment movements exist rather than silently deleting history.
ALTER TABLE business_stock_movements DROP COLUMN return_id;
ALTER TABLE business_stock_movements DROP COLUMN adjustment_id;
ALTER TABLE business_stock_movements ALTER COLUMN document_id SET NOT NULL;
DROP TABLE business_stock_adjustments,business_refunds,business_return_lines,business_returns;
ALTER TABLE business_document_lines DROP CONSTRAINT business_document_lines_tenant_id;
DROP INDEX business_documents_period;
DROP INDEX business_payments_document;
DROP INDEX business_stock_movements_lot;
ALTER TABLE business_document_lines DROP COLUMN stock_unit_cost;
