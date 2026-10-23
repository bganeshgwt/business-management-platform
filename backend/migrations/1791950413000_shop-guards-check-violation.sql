-- Up Migration
-- The guards on a shop's expenses, daily cash checks and cashier shifts raise
-- their refusal as a check violation (SQLSTATE 23514), like every other rule
-- trigger, so the business routes answer it with a 409 carrying the sentence
-- instead of a server error. Each rule and sentence stays as it is.

-- An expense is never deleted; its only change is one reversal.
CREATE OR REPLACE FUNCTION guard_business_expense() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Recorded expenses cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
     OR (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason']) IS DISTINCT FROM
        (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
    RAISE EXCEPTION 'Recorded expenses can only be reversed once, with a reason' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- A cash check is a permanent snapshot; a correction is a new check.
CREATE OR REPLACE FUNCTION guard_business_cash_check() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Cash checks are permanent snapshots; record a new check to correct one' USING ERRCODE = 'check_violation';
END $$;

-- A shift is never deleted; only its closing count is written, once.
CREATE OR REPLACE FUNCTION guard_business_counter_shift() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Cashier shifts are permanent records' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.closed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A closed shift cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['closed_at','closed_by','movement_cash','expected_cash','counted_cash','difference','reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['closed_at','closed_by','movement_cash','expected_cash','counted_cash','difference','reason']) THEN
    RAISE EXCEPTION 'Only the closing count of a shift can be recorded' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Down Migration
-- The same guards raising PostgreSQL's default error code (P0001).
CREATE OR REPLACE FUNCTION guard_business_counter_shift() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Cashier shifts are permanent records'; END IF;
  IF OLD.closed_at IS NOT NULL THEN RAISE EXCEPTION 'A closed shift cannot be changed'; END IF;
  IF (to_jsonb(NEW) - ARRAY['closed_at','closed_by','movement_cash','expected_cash','counted_cash','difference','reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['closed_at','closed_by','movement_cash','expected_cash','counted_cash','difference','reason']) THEN
    RAISE EXCEPTION 'Only the closing count of a shift can be recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION guard_business_cash_check() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Cash checks are permanent snapshots; record a new check to correct one'; END $$;
CREATE OR REPLACE FUNCTION guard_business_expense() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Recorded expenses cannot be deleted'; END IF;
 IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
   OR (to_jsonb(NEW) - ARRAY['voided_at','voided_by','void_reason']) IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['voided_at','voided_by','void_reason']) THEN
   RAISE EXCEPTION 'Recorded expenses can only be reversed once, with a reason';
 END IF;
 RETURN NEW;
END $$;
