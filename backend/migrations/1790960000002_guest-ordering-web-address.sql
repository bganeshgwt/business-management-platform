-- Up Migration

-- The web address guests' phones open from a table's QR code (sweep SW-A-14).
--
-- The QR code was built from whatever address the till's browser was on. A
-- sheet printed on a till that runs the app at http://localhost:5173 or a
-- shop-floor address like http://192.168.1.20 sent every guest's phone to an
-- address it cannot reach: the codes looked fine and worked for nobody. The
-- restaurant now keeps the one public address its guest pages live at (for
-- example https://order.myrestaurant.in), and every QR code is built from it.
-- Empty means "the address this screen is on", which the QR screens warn
-- about when that is a local one.
ALTER TABLE service_settings
  ADD COLUMN guest_web_address VARCHAR(200);

-- Down Migration

ALTER TABLE service_settings DROP COLUMN IF EXISTS guest_web_address;
