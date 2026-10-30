-- Up Migration
-- The owner's rules for who moves a restaurant's pre-orders along and for a
-- PIN someone else sets.
--
--   preorders.produce       a restaurant permission of its own: marking a
--                           pre-order In production or Ready (the bake list's
--                           buttons). Handing it over, billing and cancelling it
--                           stay as they are. Every role that may do it until
--                           now (one holding orders.create: the built-in roles
--                           and each restaurant's own roles and copies alike) is
--                           given it, so nothing changes for them; a kitchen role
--                           gets it only when the owner ticks it in the role
--                           editor.
--   users.pin_must_change   a PIN someone else set for the person (an admin, under
--                           Users). Until the person chooses their own, it signs
--                           them in on a shared till, unlocks it and switches it
--                           to them, and then asks them to choose their own at
--                           once; it approves nothing as them meanwhile. The API
--                           sets it whenever it sets a PIN for someone else, and
--                           clears it when the person sets their own PIN or the
--                           PIN is removed. Existing PINs are not marked: who set
--                           them is not known.
--   platform_modules        QR table ordering's description: Table requests is
--                           every restaurant's screen, where waiters' bill
--                           requests from the captain app arrive; QR ordering
--                           adds the guests' orders and calls to it.

-- --- Who moves pre-orders along ---------------------------------------------

INSERT INTO permissions (code, module, name, description) VALUES
 ('preorders.produce', 'kitchen', 'Move pre-orders to In production and Ready', 'The bake list''s Start baking and Ready buttons');

INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p.id
FROM role_permissions rp
JOIN permissions taking ON taking.id = rp.permission_id AND taking.code = 'orders.create'
CROSS JOIN permissions p
WHERE p.code = 'preorders.produce'
ON CONFLICT DO NOTHING;

-- --- A PIN someone else sets -------------------------------------------------

ALTER TABLE users ADD COLUMN pin_must_change BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD CONSTRAINT users_pin_must_change_has_pin CHECK (NOT pin_must_change OR pin_hash IS NOT NULL);

-- --- Table requests for every restaurant -------------------------------------

UPDATE platform_modules
SET description = 'Guests scan the QR code on their table to order or call staff; their orders and calls come to Table requests.'
WHERE code = 'qr_ordering';

-- Down Migration
UPDATE platform_modules
SET description = 'Guests scan the QR code on their table to order or call staff; the Table requests screen.'
WHERE code = 'qr_ordering';

ALTER TABLE users DROP CONSTRAINT users_pin_must_change_has_pin;
ALTER TABLE users DROP COLUMN pin_must_change;

DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'preorders.produce');
DELETE FROM permissions WHERE code = 'preorders.produce';
