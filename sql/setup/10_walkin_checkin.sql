-- Noor Gaming Lab DB setup - walk-in (direct) check-in
-- Idempotent. Run after 05_backend_rpcs.sql.
--
-- A player who walks in without a reservation is checked in straight to a free station by staff.
-- The player is either a registered member (user_id) or a guest with just a name (and optionally a phone).

ALTER TABLE bookings ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_name  TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_phone TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS walk_in     BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_customer_check') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_customer_check
            CHECK (user_id IS NOT NULL OR (guest_name IS NOT NULL AND length(btrim(guest_name)) > 0));
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- walkin_checkin: creates an ONGOING, checked-in booking on a free station, right now.
--   STATION_NOT_FOUND  unknown or inactive station
--   STATION_BUSY       someone is already checked in there
--   SLOT_TAKEN         a reservation on that station overlaps the requested time
--   INVALID_DURATION / INVALID_USER_COUNT / GUEST_REQUIRED
-- Priced like any booking (station rate x hours x players); the member's prepaid card is used when they have one.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION walkin_checkin(
    p_station_id     UUID,
    p_user_id        UUID,
    p_guest_name     TEXT,
    p_guest_phone    TEXT,
    p_duration_hours INTEGER,
    p_user_count     INTEGER,
    p_now_ist        TEXT,
    p_payment_method TEXT,
    p_notes          TEXT
) RETURNS bookings AS $$
DECLARE
    s       stations%ROWTYPE;
    v_card  user_prepaid_cards%ROWTYPE;
    v_start TIMESTAMP := p_now_ist::timestamp;
    v_end   TIMESTAMP;
    v_total NUMERIC(10,2);
    v_row   bookings;
BEGIN
    IF p_duration_hours IS NULL OR p_duration_hours < 1 OR p_duration_hours > 24 THEN RAISE EXCEPTION 'INVALID_DURATION'; END IF;
    IF p_user_count IS NULL OR p_user_count < 1 THEN RAISE EXCEPTION 'INVALID_USER_COUNT'; END IF;
    IF p_user_id IS NULL AND (p_guest_name IS NULL OR length(btrim(p_guest_name)) = 0) THEN RAISE EXCEPTION 'GUEST_REQUIRED'; END IF;

    SELECT * INTO s FROM stations WHERE id = p_station_id AND active = true FOR UPDATE;  -- serialises per station
    IF NOT FOUND THEN RAISE EXCEPTION 'STATION_NOT_FOUND'; END IF;

    IF EXISTS (
        SELECT 1 FROM bookings
        WHERE station_id = p_station_id AND checked_in = true AND status NOT IN ('CANCELLED', 'ENDED')
    ) THEN
        RAISE EXCEPTION 'STATION_BUSY';
    END IF;

    v_end := v_start + make_interval(hours => p_duration_hours);

    IF EXISTS (
        SELECT 1 FROM bookings b
        WHERE b.station_id = p_station_id AND b.status NOT IN ('CANCELLED', 'ENDED') AND b.start_time IS NOT NULL
          AND b.start_at < to_char(v_end, 'YYYY-MM-DD HH24:MI:SS') AND b.end_at > to_char(v_start, 'YYYY-MM-DD HH24:MI:SS')
    ) THEN
        RAISE EXCEPTION 'SLOT_TAKEN';
    END IF;

    v_total := round(s.hourly_rate * p_duration_hours * p_user_count, 2);

    IF p_user_id IS NOT NULL THEN
        SELECT * INTO v_card FROM user_prepaid_cards
        WHERE user_id = p_user_id AND status = 'ACTIVE' AND remaining_minutes > 0
        ORDER BY created_at LIMIT 1;
    END IF;

    INSERT INTO bookings (
        user_id, guest_name, guest_phone, walk_in, station_id,
        start_at, end_at, start_time, end_time, duration_hours, user_count,
        total_amount, original_amount, remaining_amount, amount_paid, payment_status, paid,
        payment_method, booking_notes, status, checked_in, checked_in_at, billing_type, prepaid_card_id
    ) VALUES (
        p_user_id, NULLIF(btrim(p_guest_name), ''), NULLIF(btrim(p_guest_phone), ''), true, p_station_id,
        to_char(v_start, 'YYYY-MM-DD HH24:MI:SS'), to_char(v_end, 'YYYY-MM-DD HH24:MI:SS'), v_start::time, v_end::time,
        p_duration_hours, p_user_count,
        v_total, v_total, v_total, 0, 'PENDING', false,
        NULLIF(btrim(p_payment_method), ''), NULLIF(btrim(p_notes), ''), 'ONGOING', true, now(),
        CASE WHEN v_card.id IS NOT NULL THEN 'PREPAID' ELSE 'POSTPAID' END, v_card.id
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- server only, like the other booking functions
DO $$
BEGIN
    REVOKE ALL ON FUNCTION walkin_checkin(uuid,uuid,text,text,integer,integer,text,text,text) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON FUNCTION walkin_checkin(uuid,uuid,text,text,integer,integer,text,text,text) FROM anon; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON FUNCTION walkin_checkin(uuid,uuid,text,text,integer,integer,text,text,text) FROM authenticated; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN GRANT EXECUTE ON FUNCTION walkin_checkin(uuid,uuid,text,text,integer,integer,text,text,text) TO service_role; END IF;
END $$;

NOTIFY pgrst, 'reload schema';
