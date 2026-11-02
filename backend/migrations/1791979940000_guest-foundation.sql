-- Up Migration
-- Guests' pages for businesses: what a guest does on the guests' site (an
-- online booking, an online order) makes rows in a business with nobody
-- signed in. Those rows say so, instead of naming a member of staff.
--
--   business_audit.channel
--                   who acted when no member of staff did, on a row with no
--                   actor (actor_id NULL):
--                     'guests_site'  a guest's own action on the guests'
--                                    site; the activity log shows
--                                    "Guest (online)";
--                     'automatic'    the business's own rule acting on its
--                                    own time (a request not answered in
--                                    time expires, an online order not
--                                    accepted in time is declined); the
--                                    activity log shows "Automatic".
--                   Every other row keeps its actor, as before: a row has no
--                   actor exactly when it has a channel, so a person's row
--                   always names them and these never name anyone
--                   (business_audit_actor_or_channel).
--   business_contacts.source
--                   where the customer record was made: 'staff' (a screen, an
--                   import; every record made before this) or 'guests_site'
--                   (made for a guest's booking or order when no customer of
--                   the business had their mobile, with no one signed in).
--
-- A guest page's live updates need no change here: the rows a guest watches
-- (table_request, order, reservation, appointment …) are already announced by
-- the live triggers of 1791974000000, each with its own id.

ALTER TABLE business_audit
  ADD COLUMN channel TEXT CHECK (channel IN ('guests_site', 'automatic')),
  ALTER COLUMN actor_id DROP NOT NULL,
  ADD CONSTRAINT business_audit_actor_or_channel CHECK ((actor_id IS NULL) = (channel IS NOT NULL));

ALTER TABLE business_contacts
  ADD COLUMN source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'guests_site'));

-- Down Migration
ALTER TABLE business_contacts DROP COLUMN source;

-- A guest's or an automatic row has no actor to give back: they go with the
-- rule that allowed them.
DELETE FROM business_audit WHERE actor_id IS NULL;
ALTER TABLE business_audit
  DROP CONSTRAINT business_audit_actor_or_channel,
  ALTER COLUMN actor_id SET NOT NULL,
  DROP COLUMN channel;
