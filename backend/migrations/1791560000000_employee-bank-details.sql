-- Up Migration
-- Bank details on an employee, for the payroll "Export for bank" sheet (a
-- NEFT bulk-upload file: name on the account, account number, IFSC, net pay).
-- All optional; private like the salary (shown and changed only with the
-- staff.salaries permission).

ALTER TABLE employees
  ADD COLUMN bank_account_name VARCHAR(150),
  ADD COLUMN bank_account_number VARCHAR(20),
  ADD COLUMN bank_ifsc VARCHAR(11);

ALTER TABLE employees
  ADD CONSTRAINT employees_bank_account_number_format
    CHECK (bank_account_number IS NULL OR bank_account_number ~ '^[0-9]{6,20}$'),
  ADD CONSTRAINT employees_bank_ifsc_format
    CHECK (bank_ifsc IS NULL OR bank_ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$');

COMMENT ON COLUMN employees.bank_account_name IS 'Name on the bank account, when it differs from the employee name.';
COMMENT ON COLUMN employees.bank_account_number IS 'Salary bank account number (digits only).';
COMMENT ON COLUMN employees.bank_ifsc IS 'IFSC of the salary account branch (11 characters, e.g. HDFC0001234).';

-- Down Migration
ALTER TABLE employees
  DROP CONSTRAINT IF EXISTS employees_bank_ifsc_format,
  DROP CONSTRAINT IF EXISTS employees_bank_account_number_format,
  DROP COLUMN IF EXISTS bank_ifsc,
  DROP COLUMN IF EXISTS bank_account_number,
  DROP COLUMN IF EXISTS bank_account_name;
