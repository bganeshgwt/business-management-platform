-- Up Migration

-- How a bill comes out of the printer. A browser cannot drive a thermal printer
-- directly, so these describe the receipt the browser produces: the paper it is
-- laid out for, how many copies, and whether it prints itself once the bill is
-- settled. The hardware is whatever the operating system has installed.
ALTER TABLE restaurant_settings
  -- The two thermal widths Indian restaurants use. "a4" is for a proper invoice
  -- printed on an office printer.
  ADD COLUMN print_paper_width VARCHAR(10) NOT NULL DEFAULT '80mm'
      CHECK (print_paper_width IN ('58mm', '80mm', 'a4')),
  ADD COLUMN print_copies      INTEGER     NOT NULL DEFAULT 1
      CHECK (print_copies BETWEEN 1 AND 5),
  -- Prints the receipt by itself the moment a bill is fully paid, which is what
  -- a busy counter wants; off by default because it surprises people.
  ADD COLUMN auto_print_bill   BOOLEAN     NOT NULL DEFAULT FALSE,
  -- A line above the address on the receipt, for a tagline or a phone number.
  ADD COLUMN bill_header       VARCHAR(200),
  -- Whether the receipt carries the table's ordering QR code.
  ADD COLUMN print_show_qr     BOOLEAN     NOT NULL DEFAULT FALSE;

-- Down Migration

ALTER TABLE restaurant_settings
  DROP COLUMN IF EXISTS print_paper_width,
  DROP COLUMN IF EXISTS print_copies,
  DROP COLUMN IF EXISTS auto_print_bill,
  DROP COLUMN IF EXISTS bill_header,
  DROP COLUMN IF EXISTS print_show_qr;
