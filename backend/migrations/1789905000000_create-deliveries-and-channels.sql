-- Up Migration

-- === Sales channels ===
-- Where an order came from: the restaurant's own riders, Swiggy, Zomato, a
-- phone call, the website. A channel carries the commission it keeps, so the
-- report can say what a ₹600 Zomato bill is really worth to the restaurant.
CREATE TABLE sales_channels (
  id                  BIGINT        GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id       BIGINT        NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name                VARCHAR(60)   NOT NULL,
  -- aggregator = the partner app's own fleet usually carries the food, so a
  -- dispatch may name their rider instead of one of ours.
  channel_type        VARCHAR(20)   NOT NULL DEFAULT 'own'
                      CHECK (channel_type IN ('own', 'aggregator', 'phone', 'website')),
  -- No aggregator in India takes more than half a bill; anything above that
  -- is a typo for a smaller number, not a real contract.
  commission_percent  NUMERIC(5,2)  NOT NULL DEFAULT 0
                      CHECK (commission_percent >= 0 AND commission_percent <= 50),
  -- A named swatch rather than a hex code, so every badge has a readable
  -- light and dark version (the same palette as kitchen stations).
  color               VARCHAR(20)   NOT NULL DEFAULT 'slate'
                      CHECK (color IN ('orange', 'red', 'amber', 'green', 'teal', 'blue',
                                       'violet', 'pink', 'slate')),
  sort_order          INTEGER       NOT NULL DEFAULT 0,
  status              VARCHAR(20)   NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive')),
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  created_by          BIGINT        REFERENCES users(id),
  updated_by          BIGINT        REFERENCES users(id)
);

-- "Swiggy" and "swiggy" are the same partner.
CREATE UNIQUE INDEX uq_sales_channels_name ON sales_channels (restaurant_id, LOWER(name));

CREATE TRIGGER trg_sales_channels_updated_at
BEFORE UPDATE ON sales_channels
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every restaurant that already exists starts with the usual five. A
-- restaurant created later gets them the first time the deliveries screen
-- asks (see delivery.repository ensureDefaultChannels).
INSERT INTO sales_channels (restaurant_id, name, channel_type, commission_percent, color, sort_order)
SELECT r.id, d.name, d.channel_type, d.commission_percent, d.color, d.sort_order
FROM restaurants r
CROSS JOIN (VALUES
  ('Own delivery', 'own',        0,  'green',  0),
  ('Swiggy',       'aggregator', 22, 'orange', 10),
  ('Zomato',       'aggregator', 25, 'red',    20),
  ('Phone',        'phone',      0,  'blue',   30),
  ('Website',      'website',    0,  'violet', 40)
) AS d (name, channel_type, commission_percent, color, sort_order);

-- === Delivery details on the order ===
-- Kept on the order rather than in a side table: a delivery IS the order, and
-- the bill, the kitchen ticket and the report all already start from orders.
-- Every column is nullable, so dine-in, takeaway and every existing query
-- carry on exactly as before.
ALTER TABLE orders
  ADD COLUMN channel_id                 BIGINT REFERENCES sales_channels(id) ON DELETE SET NULL,
  -- The rate in force when the order was tagged. Swiggy renegotiating next
  -- month must not rewrite what last month's orders cost.
  ADD COLUMN channel_commission_percent NUMERIC(5,2)
             CHECK (channel_commission_percent IS NULL
                    OR (channel_commission_percent >= 0 AND channel_commission_percent <= 50)),
  -- NULL on a delivery order means "nobody has touched it yet" and reads as
  -- pending. Preparing and ready also follow the kitchen display on their own.
  ADD COLUMN delivery_status            VARCHAR(20)
             CHECK (delivery_status IS NULL OR delivery_status IN
                    ('pending', 'preparing', 'ready', 'out_for_delivery', 'delivered', 'cancelled')),
  ADD COLUMN delivery_address           VARCHAR(500),
  ADD COLUMN delivery_landmark          VARCHAR(200),
  -- Our own rider: an employee in the delivery department. SET NULL so a
  -- staff record can still be removed; while food is out the check below
  -- refuses that, because someone has to be holding it.
  ADD COLUMN rider_employee_id          BIGINT REFERENCES employees(id) ON DELETE SET NULL,
  -- The partner app's rider, by name, when Swiggy or Zomato send their own.
  ADD COLUMN partner_rider_name         VARCHAR(100),
  -- The aggregator's order id, which is what their support desk asks for.
  ADD COLUMN external_order_ref         VARCHAR(60),
  -- What the guest was promised, in minutes from placing the order.
  ADD COLUMN delivery_eta_minutes       SMALLINT
             CHECK (delivery_eta_minutes IS NULL OR delivery_eta_minutes BETWEEN 5 AND 240),
  ADD COLUMN delivery_preparing_at      TIMESTAMPTZ,
  ADD COLUMN delivery_ready_at          TIMESTAMPTZ,
  ADD COLUMN dispatched_at              TIMESTAMPTZ,
  ADD COLUMN delivered_at               TIMESTAMPTZ,
  ADD COLUMN delivery_cancelled_at      TIMESTAMPTZ,
  ADD COLUMN delivery_cancel_reason     VARCHAR(200),
  -- Food on the road is in somebody's hands, with a time it left.
  ADD CONSTRAINT chk_orders_delivery_out
    CHECK (delivery_status IS DISTINCT FROM 'out_for_delivery'
           OR (dispatched_at IS NOT NULL
               AND (rider_employee_id IS NOT NULL OR partner_rider_name IS NOT NULL))),
  -- A cancellation with no reason cannot be learnt from later.
  ADD CONSTRAINT chk_orders_delivery_cancel_reason
    CHECK (delivery_status IS DISTINCT FROM 'cancelled' OR delivery_cancel_reason IS NOT NULL);

-- The board: every delivery order of the open business day.
CREATE INDEX idx_orders_delivery_day ON orders (restaurant_id, business_day_id)
  WHERE order_type = 'delivery';

-- Food still out when the day was closed stays on the board until it lands.
CREATE INDEX idx_orders_delivery_live ON orders (restaurant_id, placed_at)
  WHERE order_type = 'delivery'
    AND delivery_status IN ('pending', 'preparing', 'ready', 'out_for_delivery');

-- "What is Ravi carrying?" and the rider figures.
CREATE INDEX idx_orders_rider ON orders (rider_employee_id) WHERE rider_employee_id IS NOT NULL;

-- A channel with orders cannot be deleted; this answers "has it any?".
CREATE INDEX idx_orders_channel ON orders (channel_id) WHERE channel_id IS NOT NULL;

-- Delivery orders from before this existed. Days already closed were dealt
-- with, so they are delivered — with no delivered time, because making one up
-- would put invented minutes into the delivery-time figures. Cancelled
-- orders are cancelled deliveries. Anything on the open day is left pending
-- for the dispatcher to settle.
--
-- The updated_at trigger is held off for this one statement: tagging history
-- is not somebody editing those orders, and "last changed" must still say
-- when a person last did.
ALTER TABLE orders DISABLE TRIGGER trg_orders_updated_at;

UPDATE orders o
SET delivery_status = CASE WHEN o.order_status = 'cancelled' THEN 'cancelled' ELSE 'delivered' END,
    delivery_cancelled_at = CASE WHEN o.order_status = 'cancelled' THEN o.updated_at END,
    delivery_cancel_reason = CASE WHEN o.order_status = 'cancelled'
                                  THEN COALESCE(o.cancel_reason, 'Order cancelled') END
WHERE o.order_type = 'delivery'
  AND o.delivery_status IS NULL
  AND (o.order_status = 'cancelled'
       OR NOT EXISTS (SELECT 1 FROM business_days bd
                      WHERE bd.id = o.business_day_id AND bd.day_status = 'open'));

ALTER TABLE orders ENABLE TRIGGER trg_orders_updated_at;

-- Down Migration

DROP INDEX IF EXISTS idx_orders_channel;
DROP INDEX IF EXISTS idx_orders_rider;
DROP INDEX IF EXISTS idx_orders_delivery_live;
DROP INDEX IF EXISTS idx_orders_delivery_day;

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS chk_orders_delivery_cancel_reason,
  DROP CONSTRAINT IF EXISTS chk_orders_delivery_out,
  DROP COLUMN IF EXISTS delivery_cancel_reason,
  DROP COLUMN IF EXISTS delivery_cancelled_at,
  DROP COLUMN IF EXISTS delivered_at,
  DROP COLUMN IF EXISTS dispatched_at,
  DROP COLUMN IF EXISTS delivery_ready_at,
  DROP COLUMN IF EXISTS delivery_preparing_at,
  DROP COLUMN IF EXISTS delivery_eta_minutes,
  DROP COLUMN IF EXISTS external_order_ref,
  DROP COLUMN IF EXISTS partner_rider_name,
  DROP COLUMN IF EXISTS rider_employee_id,
  DROP COLUMN IF EXISTS delivery_landmark,
  DROP COLUMN IF EXISTS delivery_address,
  DROP COLUMN IF EXISTS delivery_status,
  DROP COLUMN IF EXISTS channel_commission_percent,
  DROP COLUMN IF EXISTS channel_id;

DROP TABLE IF EXISTS sales_channels;
