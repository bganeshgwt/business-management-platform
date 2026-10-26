-- Up Migration
-- Live updates. The screens that show what other devices change (the kitchen
-- display, table requests, the POS's running tables, deliveries, the
-- collection display, the dashboard, reservations, the bell, the time clock;
-- a clinic's token queue, a salon's calendar, my tasks, a jeweller's rate
-- board) hear of a change within about a second, instead of asking the server
-- again every few seconds.
--
-- The database announces each change itself. A trigger on every table those
-- screens read calls pg_notify, so no code path can forget to announce, and
-- PostgreSQL delivers a notification only when its transaction commits, in
-- commit order: a change that rolls back (or a savepoint rolled back) is never
-- announced. Identical notifications in one transaction (ten dishes added to
-- one order) reach the listeners once. Each API process LISTENs on one
-- connection of its own and passes each notification on to the screens open
-- for that restaurant or business (backend/src/modules/live).
--
-- A notification says where and what changed, never the data: the restaurant
-- (and outlet) or the business (and location), the area, and the id of the
-- row, e.g. {"restaurant":12,"outlet":3,"area":"order","id":456}. The screen
-- then reads again through the normal API, which checks what the person may
-- see.
--
-- Channel live_change carries the changes:
--   - the restaurant's own tables, each in an area: order (orders, their
--     dishes and joined tables), kot (kitchen tickets and their lines),
--     kot_slip, table_request, table, bill (bills, their payments and
--     refunds), reservation (with the tables it holds), waitlist, sold_out,
--     timeclock, preorder and business_day;
--   - the shared core's outbox, business_events: the area is the event's kind
--     up to its dot (sale, appointment, collection, jewellery_rates, ...), the
--     id its entity, the location its payload's locationId when it has one;
--   - the business tables the live screens read that write no event of their
--     own: tokens, appointments, salon walk-ins, tasks, task lines and
--     assignees, issues, and jewellery rate sheets.
--   A business that is a restaurant's own (its tasks and issues) is announced
--   as that restaurant, whose screens show them.
-- Channel live_session carries what may end a stream, so it is checked again
-- at once: a login's token version, status, restaurant, outlet or must-change
-- mark; a restaurant's or a business's status; a membership changed or
-- removed; a business role switched off.

-- --- Announcing a change ------------------------------------------------------

-- One change: where (a restaurant and its outlet, or a business and its
-- location), what (the area) and which row. What is not known is left out.
CREATE FUNCTION live_announce(scope TEXT, tenant BIGINT, branch BIGINT, area TEXT, ref BIGINT) RETURNS void LANGUAGE sql AS $$
  SELECT pg_notify('live_change', json_strip_nulls(json_build_object(
    scope, tenant, CASE scope WHEN 'restaurant' THEN 'outlet' ELSE 'location' END, branch, 'area', area, 'id', ref))::text);
$$;

-- A business's change, or, for a business that is a restaurant's own, that
-- restaurant's (with the row's outlet).
CREATE FUNCTION live_announce_business(business BIGINT, place BIGINT, outlet BIGINT, area TEXT, ref BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  restaurant BIGINT;
BEGIN
  SELECT legacy_restaurant_id INTO restaurant FROM businesses WHERE id = business;
  IF restaurant IS NOT NULL THEN
    PERFORM live_announce('restaurant', restaurant, outlet, area, ref);
  ELSE
    PERFORM live_announce('business', business, place, area, ref);
  END IF;
END $$;

-- A restaurant table's row, with its own restaurant_id (and outlet_id when it
-- has one). Arguments: the area, and the column holding the id announced. An
-- update that changes nothing but updated_at is no change; a row moved to
-- another outlet is announced at both.
CREATE FUNCTION live_restaurant_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_row JSONB := to_jsonb(COALESCE(NEW, OLD));
  was_row JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
BEGIN
  IF TG_OP = 'UPDATE' AND (now_row - 'updated_at') = (was_row - 'updated_at') THEN
    RETURN NULL;
  END IF;
  PERFORM live_announce('restaurant', (now_row->>'restaurant_id')::bigint, (now_row->>'outlet_id')::bigint, TG_ARGV[0], (now_row->>TG_ARGV[1])::bigint);
  IF TG_OP = 'UPDATE' AND (was_row->>'outlet_id') IS DISTINCT FROM (now_row->>'outlet_id') THEN
    PERFORM live_announce('restaurant', (was_row->>'restaurant_id')::bigint, (was_row->>'outlet_id')::bigint, TG_ARGV[0], (was_row->>TG_ARGV[1])::bigint);
  END IF;
  RETURN NULL;
END $$;

-- A restaurant row that belongs to another (a dish on an order, a line on a
-- kitchen ticket, a payment or refund on a bill, a table a booking holds) is
-- announced as its parent: in the parent's area, with the parent's id,
-- restaurant and outlet. Arguments: the parent's area and the column pointing
-- at it. A row moved from one parent to another is announced for both.
CREATE FUNCTION live_restaurant_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_row JSONB := to_jsonb(COALESCE(NEW, OLD));
  was_row JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  parent BIGINT;
  tenant BIGINT;
  branch BIGINT;
BEGIN
  IF TG_OP = 'UPDATE' AND (now_row - 'updated_at') = (was_row - 'updated_at') THEN
    RETURN NULL;
  END IF;
  FOR parent IN
    SELECT DISTINCT p FROM unnest(ARRAY[(now_row->>TG_ARGV[1])::bigint, (was_row->>TG_ARGV[1])::bigint]) AS p WHERE p IS NOT NULL
  LOOP
    CASE TG_ARGV[0]
      WHEN 'order' THEN SELECT restaurant_id, outlet_id INTO tenant, branch FROM orders WHERE id = parent;
      WHEN 'kot' THEN SELECT restaurant_id, outlet_id INTO tenant, branch FROM kots WHERE id = parent;
      WHEN 'bill' THEN SELECT restaurant_id, outlet_id INTO tenant, branch FROM bills WHERE id = parent;
      WHEN 'reservation' THEN SELECT restaurant_id, outlet_id INTO tenant, branch FROM reservations WHERE id = parent;
      ELSE RAISE EXCEPTION 'live_restaurant_part() does not know the area %', TG_ARGV[0];
    END CASE;
    -- A parent removed in the same statement announced itself.
    IF FOUND THEN
      PERFORM live_announce('restaurant', tenant, branch, TG_ARGV[0], parent);
    END IF;
  END LOOP;
  RETURN NULL;
END $$;

-- A business table's row, with its business_id (and location_id, or
-- outlet_id for a restaurant's own business, when it has one). Arguments: the
-- area, and the column holding the id announced.
CREATE FUNCTION live_business_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_row JSONB := to_jsonb(COALESCE(NEW, OLD));
BEGIN
  IF TG_OP = 'UPDATE' AND (now_row - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN
    RETURN NULL;
  END IF;
  PERFORM live_announce_business((now_row->>'business_id')::bigint, (now_row->>'location_id')::bigint, (now_row->>'outlet_id')::bigint,
    TG_ARGV[0], (now_row->>TG_ARGV[1])::bigint);
  RETURN NULL;
END $$;

-- The shared core's outbox: a posting's event is announced in the area its
-- kind starts with, for its entity, at the location its payload names.
CREATE FUNCTION live_business_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM live_announce_business(NEW.business_id,
    CASE WHEN NEW.payload->>'locationId' ~ '^[1-9][0-9]{0,17}$' THEN (NEW.payload->>'locationId')::bigint END,
    NULL, split_part(NEW.kind, '.', 1), NEW.entity_id);
  RETURN NULL;
END $$;

-- Something that may end a stream. Arguments: pairs of a key and the column
-- holding its id, e.g. ('user', 'id') or ('user', 'user_id', 'business', 'business_id').
CREATE FUNCTION live_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_row JSONB := to_jsonb(COALESCE(NEW, OLD));
  said JSONB := '{}';
  i INT := 0;
BEGIN
  WHILE i + 1 < TG_NARGS LOOP
    said := said || jsonb_build_object(TG_ARGV[i], (now_row->>TG_ARGV[i + 1])::bigint);
    i := i + 2;
  END LOOP;
  PERFORM pg_notify('live_session', said::text);
  RETURN NULL;
END $$;

-- --- The restaurant's tables -------------------------------------------------

CREATE TRIGGER trg_orders_live AFTER INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('order', 'id');
CREATE TRIGGER trg_order_items_live AFTER INSERT OR UPDATE OR DELETE ON order_items
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_part('order', 'order_id');
CREATE TRIGGER trg_order_joined_tables_live AFTER INSERT OR UPDATE OR DELETE ON order_joined_tables
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_part('order', 'order_id');
CREATE TRIGGER trg_kots_live AFTER INSERT OR UPDATE OR DELETE ON kots
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('kot', 'id');
CREATE TRIGGER trg_kot_items_live AFTER INSERT OR UPDATE OR DELETE ON kot_items
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_part('kot', 'kot_id');
CREATE TRIGGER trg_kot_change_slips_live AFTER INSERT OR UPDATE OR DELETE ON kot_change_slips
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('kot_slip', 'id');
CREATE TRIGGER trg_table_requests_live AFTER INSERT OR UPDATE OR DELETE ON table_requests
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('table_request', 'id');
CREATE TRIGGER trg_dining_tables_live AFTER INSERT OR UPDATE OR DELETE ON dining_tables
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('table', 'id');
CREATE TRIGGER trg_bills_live AFTER INSERT OR UPDATE OR DELETE ON bills
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('bill', 'id');
CREATE TRIGGER trg_payments_live AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_part('bill', 'bill_id');
CREATE TRIGGER trg_refunds_live AFTER INSERT OR UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_part('bill', 'bill_id');
CREATE TRIGGER trg_reservations_live AFTER INSERT OR UPDATE OR DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('reservation', 'id');
CREATE TRIGGER trg_reservation_tables_live AFTER INSERT OR UPDATE OR DELETE ON reservation_tables
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_part('reservation', 'reservation_id');
CREATE TRIGGER trg_waitlist_entries_live AFTER INSERT OR UPDATE OR DELETE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('waitlist', 'id');
CREATE TRIGGER trg_menu_sold_out_live AFTER INSERT OR UPDATE OR DELETE ON menu_sold_out
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('sold_out', 'id');
CREATE TRIGGER trg_attendance_punches_live AFTER INSERT OR UPDATE OR DELETE ON attendance_punches
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('timeclock', 'id');
CREATE TRIGGER trg_attendance_live AFTER INSERT OR UPDATE OR DELETE ON attendance
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('timeclock', 'id');
CREATE TRIGGER trg_restaurant_preorders_live AFTER INSERT OR UPDATE OR DELETE ON restaurant_preorders
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('preorder', 'id');
CREATE TRIGGER trg_business_days_live AFTER INSERT OR UPDATE OR DELETE ON business_days
  FOR EACH ROW EXECUTE FUNCTION live_restaurant_row('business_day', 'id');

-- --- The businesses' tables --------------------------------------------------

CREATE TRIGGER business_events_live AFTER INSERT ON business_events
  FOR EACH ROW EXECUTE FUNCTION live_business_event();
CREATE TRIGGER health_tokens_live AFTER INSERT OR UPDATE OR DELETE ON health_tokens
  FOR EACH ROW EXECUTE FUNCTION live_business_row('token', 'id');
CREATE TRIGGER business_appointments_live AFTER INSERT OR UPDATE OR DELETE ON business_appointments
  FOR EACH ROW EXECUTE FUNCTION live_business_row('appointment', 'id');
CREATE TRIGGER salon_walk_ins_live AFTER INSERT OR UPDATE OR DELETE ON salon_walk_ins
  FOR EACH ROW EXECUTE FUNCTION live_business_row('walk_in', 'id');
CREATE TRIGGER business_tasks_live AFTER INSERT OR UPDATE OR DELETE ON business_tasks
  FOR EACH ROW EXECUTE FUNCTION live_business_row('task', 'id');
CREATE TRIGGER business_task_assignees_live AFTER INSERT OR UPDATE OR DELETE ON business_task_assignees
  FOR EACH ROW EXECUTE FUNCTION live_business_row('task', 'task_id');
CREATE TRIGGER business_task_items_live AFTER INSERT OR UPDATE OR DELETE ON business_task_items
  FOR EACH ROW EXECUTE FUNCTION live_business_row('task', 'task_id');
CREATE TRIGGER business_issues_live AFTER INSERT OR UPDATE OR DELETE ON business_issues
  FOR EACH ROW EXECUTE FUNCTION live_business_row('issue', 'id');
CREATE TRIGGER jewellery_rate_sheets_live AFTER INSERT ON jewellery_rate_sheets
  FOR EACH ROW EXECUTE FUNCTION live_business_row('jewellery_rates', 'id');

-- --- What may end a stream ---------------------------------------------------

CREATE TRIGGER trg_users_live_session AFTER UPDATE OF token_version, status, restaurant_id, outlet_id, password_must_change ON users
  FOR EACH ROW WHEN (OLD.token_version IS DISTINCT FROM NEW.token_version OR OLD.status IS DISTINCT FROM NEW.status
    OR OLD.restaurant_id IS DISTINCT FROM NEW.restaurant_id OR OLD.outlet_id IS DISTINCT FROM NEW.outlet_id
    OR OLD.password_must_change IS DISTINCT FROM NEW.password_must_change)
  EXECUTE FUNCTION live_session('user', 'id');
CREATE TRIGGER trg_restaurants_live_session AFTER UPDATE OF status ON restaurants
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION live_session('restaurant', 'id');
CREATE TRIGGER businesses_live_session AFTER UPDATE OF status ON businesses
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION live_session('business', 'id');
CREATE TRIGGER business_memberships_live_session AFTER UPDATE OF active, role_id, location_id ON business_memberships
  FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active OR OLD.role_id IS DISTINCT FROM NEW.role_id OR OLD.location_id IS DISTINCT FROM NEW.location_id)
  EXECUTE FUNCTION live_session('user', 'user_id', 'business', 'business_id');
CREATE TRIGGER business_memberships_live_session_gone AFTER DELETE ON business_memberships
  FOR EACH ROW EXECUTE FUNCTION live_session('user', 'user_id', 'business', 'business_id');
CREATE TRIGGER business_roles_live_session AFTER UPDATE OF active ON business_roles
  FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active) EXECUTE FUNCTION live_session('business', 'business_id');

-- Down Migration
DROP TRIGGER business_roles_live_session ON business_roles;
DROP TRIGGER business_memberships_live_session_gone ON business_memberships;
DROP TRIGGER business_memberships_live_session ON business_memberships;
DROP TRIGGER businesses_live_session ON businesses;
DROP TRIGGER trg_restaurants_live_session ON restaurants;
DROP TRIGGER trg_users_live_session ON users;
DROP TRIGGER jewellery_rate_sheets_live ON jewellery_rate_sheets;
DROP TRIGGER business_issues_live ON business_issues;
DROP TRIGGER business_task_items_live ON business_task_items;
DROP TRIGGER business_task_assignees_live ON business_task_assignees;
DROP TRIGGER business_tasks_live ON business_tasks;
DROP TRIGGER salon_walk_ins_live ON salon_walk_ins;
DROP TRIGGER business_appointments_live ON business_appointments;
DROP TRIGGER health_tokens_live ON health_tokens;
DROP TRIGGER business_events_live ON business_events;
DROP TRIGGER trg_business_days_live ON business_days;
DROP TRIGGER trg_restaurant_preorders_live ON restaurant_preorders;
DROP TRIGGER trg_attendance_live ON attendance;
DROP TRIGGER trg_attendance_punches_live ON attendance_punches;
DROP TRIGGER trg_menu_sold_out_live ON menu_sold_out;
DROP TRIGGER trg_waitlist_entries_live ON waitlist_entries;
DROP TRIGGER trg_reservation_tables_live ON reservation_tables;
DROP TRIGGER trg_reservations_live ON reservations;
DROP TRIGGER trg_refunds_live ON refunds;
DROP TRIGGER trg_payments_live ON payments;
DROP TRIGGER trg_bills_live ON bills;
DROP TRIGGER trg_dining_tables_live ON dining_tables;
DROP TRIGGER trg_table_requests_live ON table_requests;
DROP TRIGGER trg_kot_change_slips_live ON kot_change_slips;
DROP TRIGGER trg_kot_items_live ON kot_items;
DROP TRIGGER trg_kots_live ON kots;
DROP TRIGGER trg_order_joined_tables_live ON order_joined_tables;
DROP TRIGGER trg_order_items_live ON order_items;
DROP TRIGGER trg_orders_live ON orders;
DROP FUNCTION live_session();
DROP FUNCTION live_business_event();
DROP FUNCTION live_business_row();
DROP FUNCTION live_restaurant_part();
DROP FUNCTION live_restaurant_row();
DROP FUNCTION live_announce_business(BIGINT, BIGINT, BIGINT, TEXT, BIGINT);
DROP FUNCTION live_announce(TEXT, BIGINT, BIGINT, TEXT, BIGINT);
