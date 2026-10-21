-- Up Migration
-- PostgreSQL CHECK accepts NULL, so a financial reason must be explicit.
ALTER TABLE business_expenses DROP CONSTRAINT business_expenses_check;
ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_void_shape CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
 OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND void_reason IS NOT NULL AND length(trim(void_reason))>0)
);
ALTER TABLE business_cash_checks DROP CONSTRAINT business_cash_checks_check1;
ALTER TABLE business_cash_checks ADD CONSTRAINT business_cash_checks_reason CHECK (
 difference=0 OR (reason IS NOT NULL AND length(trim(reason))>0)
);

-- Down Migration
ALTER TABLE business_expenses DROP CONSTRAINT business_expenses_void_shape;
ALTER TABLE business_expenses ADD CONSTRAINT business_expenses_check CHECK (
 (voided_at IS NULL AND voided_by IS NULL AND void_reason IS NULL)
 OR (voided_at IS NOT NULL AND voided_by IS NOT NULL AND length(trim(void_reason))>0)
);
ALTER TABLE business_cash_checks DROP CONSTRAINT business_cash_checks_reason;
ALTER TABLE business_cash_checks ADD CONSTRAINT business_cash_checks_check1 CHECK (difference=0 OR length(trim(reason))>0);
