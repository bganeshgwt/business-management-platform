-- Up Migration
-- The restaurant's own rules for alerts and timings.
--
-- Until now these lines were written into the code: a discount was "large" at
-- 20% or ₹1,000, a delivery late after 45 minutes, a guest a regular at three
-- visits in 60 days, the reorder plan looked back a fortnight, and so on. A
-- dosa counter and a fine-dining room do not share those numbers, so each
-- becomes a setting of the restaurant, edited on Settings -> Alerts and
-- timings.
--
-- Every DEFAULT is the number the code used, so nothing anyone sees changes
-- until an owner edits it. The ranges keep a typo from switching a rule off
-- (a 0-minute "late" would ring for every booking) or making it meaningless.
--
-- Already settings elsewhere, and so not repeated here: the kitchen's warn and
-- late marks (kitchen_settings, where the pass time joins them below), the
-- cash difference that needs a reason (restaurant_settings
-- .cash_variance_threshold, which is also where the cash-short alert's
-- warning now starts), and the online booking link's notice, sitting length
-- and seat share (online_booking_settings).

ALTER TABLE restaurant_settings
  -- Theft control: the bell and the theft report's default line.
  ADD COLUMN alert_large_discount_percent SMALLINT NOT NULL DEFAULT 20
    CHECK (alert_large_discount_percent BETWEEN 1 AND 100),
  ADD COLUMN alert_large_discount_amount NUMERIC(12,2) NOT NULL DEFAULT 1000
    CHECK (alert_large_discount_amount >= 1 AND alert_large_discount_amount <= 10000000),
  ADD COLUMN alert_huge_discount_percent SMALLINT NOT NULL DEFAULT 50
    CHECK (alert_huge_discount_percent BETWEEN 1 AND 100),
  ADD COLUMN alert_reprint_count SMALLINT NOT NULL DEFAULT 3
    CHECK (alert_reprint_count BETWEEN 2 AND 20),
  ADD COLUMN alert_cash_short_critical NUMERIC(12,2) NOT NULL DEFAULT 1000
    CHECK (alert_cash_short_critical >= 1 AND alert_cash_short_critical <= 10000000),
  ADD CONSTRAINT chk_restaurant_settings_huge_discount
    CHECK (alert_huge_discount_percent >= alert_large_discount_percent),

  -- Deliveries: door-to-door promise, when the board turns amber, packed food
  -- waiting for a rider, and a run that has gone on too long.
  ADD COLUMN delivery_sla_minutes SMALLINT NOT NULL DEFAULT 45
    CHECK (delivery_sla_minutes BETWEEN 10 AND 240),
  ADD COLUMN delivery_warn_minutes SMALLINT NOT NULL DEFAULT 30
    CHECK (delivery_warn_minutes BETWEEN 5 AND 235),
  ADD COLUMN delivery_ready_wait_minutes SMALLINT NOT NULL DEFAULT 10
    CHECK (delivery_ready_wait_minutes BETWEEN 1 AND 120),
  ADD COLUMN delivery_out_warn_minutes SMALLINT NOT NULL DEFAULT 45
    CHECK (delivery_out_warn_minutes BETWEEN 5 AND 240),
  ADD COLUMN delivery_out_critical_minutes SMALLINT NOT NULL DEFAULT 60
    CHECK (delivery_out_critical_minutes BETWEEN 10 AND 480),
  ADD CONSTRAINT chk_restaurant_settings_delivery_warn
    CHECK (delivery_warn_minutes < delivery_sla_minutes),
  ADD CONSTRAINT chk_restaurant_settings_delivery_out
    CHECK (delivery_out_critical_minutes > delivery_out_warn_minutes),

  -- Reservations: when a booking counts as late, the last seating before
  -- closing, and the step between the times the online booking page offers.
  ADD COLUMN reservation_late_minutes SMALLINT NOT NULL DEFAULT 15
    CHECK (reservation_late_minutes BETWEEN 1 AND 180),
  ADD COLUMN reservation_last_seating_minutes SMALLINT NOT NULL DEFAULT 30
    CHECK (reservation_last_seating_minutes BETWEEN 0 AND 240),
  ADD COLUMN reservation_slot_minutes SMALLINT NOT NULL DEFAULT 30
    CHECK (reservation_slot_minutes IN (10, 15, 20, 30, 45, 60)),

  -- Time clock: not in yet, a long break, when staying on is overtime, and
  -- how early the clock opens before a rostered start.
  ADD COLUMN timeclock_late_minutes SMALLINT NOT NULL DEFAULT 15
    CHECK (timeclock_late_minutes BETWEEN 1 AND 240),
  ADD COLUMN timeclock_long_break_minutes SMALLINT NOT NULL DEFAULT 45
    CHECK (timeclock_long_break_minutes BETWEEN 5 AND 480),
  ADD COLUMN timeclock_overtime_minutes SMALLINT NOT NULL DEFAULT 15
    CHECK (timeclock_overtime_minutes BETWEEN 0 AND 240),
  ADD COLUMN timeclock_early_minutes SMALLINT NOT NULL DEFAULT 60
    CHECK (timeclock_early_minutes BETWEEN 0 AND 720),

  -- Guest insights and the guest book's quick views.
  ADD COLUMN guest_regular_visits SMALLINT NOT NULL DEFAULT 3
    CHECK (guest_regular_visits BETWEEN 2 AND 50),
  ADD COLUMN guest_regular_days SMALLINT NOT NULL DEFAULT 60
    CHECK (guest_regular_days BETWEEN 7 AND 730),
  ADD COLUMN guest_lapsed_days SMALLINT NOT NULL DEFAULT 45
    CHECK (guest_lapsed_days BETWEEN 7 AND 730),
  ADD COLUMN guest_new_days SMALLINT NOT NULL DEFAULT 30
    CHECK (guest_new_days BETWEEN 1 AND 365),
  ADD COLUMN guest_big_spender_percent SMALLINT NOT NULL DEFAULT 10
    CHECK (guest_big_spender_percent BETWEEN 1 AND 50),

  -- The reorder plan: how far back usage is read, the safety cushion, and
  -- the days a plan covers when nobody picks another.
  ADD COLUMN reorder_lookback_days SMALLINT NOT NULL DEFAULT 14
    CHECK (reorder_lookback_days BETWEEN 3 AND 90),
  ADD COLUMN reorder_safety_days SMALLINT NOT NULL DEFAULT 2
    CHECK (reorder_safety_days BETWEEN 0 AND 30),
  ADD COLUMN reorder_horizon_days SMALLINT NOT NULL DEFAULT 7
    CHECK (reorder_horizon_days BETWEEN 1 AND 30),

  -- The notes a cash count lists, in whole rupees; coins are always counted
  -- as one amount besides. The default is what every counting screen has
  -- shown (₹2,000 notes are out of circulation).
  ADD COLUMN cash_denominations INT[] NOT NULL DEFAULT '{500,200,100,50,20,10}'
    CHECK (
      cardinality(cash_denominations) BETWEEN 1 AND 15
      AND array_position(cash_denominations, NULL) IS NULL
      AND 1 <= ALL (cash_denominations)
      AND 100000 >= ALL (cash_denominations)
    );

-- Food plated and waiting at the pass this long is going cold: beside the
-- kitchen's own warn and late marks.
ALTER TABLE kitchen_settings
  ADD COLUMN pass_minutes SMALLINT NOT NULL DEFAULT 8 CHECK (pass_minutes BETWEEN 1 AND 60);

-- Down Migration

ALTER TABLE kitchen_settings DROP COLUMN IF EXISTS pass_minutes;

ALTER TABLE restaurant_settings
  DROP CONSTRAINT IF EXISTS chk_restaurant_settings_huge_discount,
  DROP CONSTRAINT IF EXISTS chk_restaurant_settings_delivery_warn,
  DROP CONSTRAINT IF EXISTS chk_restaurant_settings_delivery_out,
  DROP COLUMN IF EXISTS alert_large_discount_percent,
  DROP COLUMN IF EXISTS alert_large_discount_amount,
  DROP COLUMN IF EXISTS alert_huge_discount_percent,
  DROP COLUMN IF EXISTS alert_reprint_count,
  DROP COLUMN IF EXISTS alert_cash_short_critical,
  DROP COLUMN IF EXISTS delivery_sla_minutes,
  DROP COLUMN IF EXISTS delivery_warn_minutes,
  DROP COLUMN IF EXISTS delivery_ready_wait_minutes,
  DROP COLUMN IF EXISTS delivery_out_warn_minutes,
  DROP COLUMN IF EXISTS delivery_out_critical_minutes,
  DROP COLUMN IF EXISTS reservation_late_minutes,
  DROP COLUMN IF EXISTS reservation_last_seating_minutes,
  DROP COLUMN IF EXISTS reservation_slot_minutes,
  DROP COLUMN IF EXISTS timeclock_late_minutes,
  DROP COLUMN IF EXISTS timeclock_long_break_minutes,
  DROP COLUMN IF EXISTS timeclock_overtime_minutes,
  DROP COLUMN IF EXISTS timeclock_early_minutes,
  DROP COLUMN IF EXISTS guest_regular_visits,
  DROP COLUMN IF EXISTS guest_regular_days,
  DROP COLUMN IF EXISTS guest_lapsed_days,
  DROP COLUMN IF EXISTS guest_new_days,
  DROP COLUMN IF EXISTS guest_big_spender_percent,
  DROP COLUMN IF EXISTS reorder_lookback_days,
  DROP COLUMN IF EXISTS reorder_safety_days,
  DROP COLUMN IF EXISTS reorder_horizon_days,
  DROP COLUMN IF EXISTS cash_denominations;
