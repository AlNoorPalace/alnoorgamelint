-- Noor Gaming Lab DB setup - extra controllers
-- Idempotent. Run after 05, 06 and 10.
--
-- Each station has a price per extra controller per hour (stations.extra_controller_rate, default 0 = not offered).
-- A booking stores how many extra controllers it has and what they cost for the whole booked time.
-- Charge = extra_controllers x extra_controller_rate x duration_hours; it is part of total_amount.

ALTER TABLE stations ADD COLUMN IF NOT EXISTS extra_controller_rate NUMERIC(8,2) NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_controllers INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS controller_charge NUMERIC(10,2) NOT NULL DEFAULT 0;

-- the signatures change (a trailing parameter is added), so the old ones go
DROP FUNCTION IF EXISTS create_booking(uuid,uuid,text,text,text,text,text,integer,integer,boolean,json,numeric,text);
DROP FUNCTION IF EXISTS walkin_checkin(uuid,uuid,text,text,integer,integer,text,text,text);

CREATE OR REPLACE FUNCTION create_booking(
    p_user_id        UUID,
    p_station_id     UUID,
    p_station_type   TEXT,
    p_start_at       TEXT,
    p_end_at         TEXT,
    p_start_time     TEXT,
    p_end_time       TEXT,
    p_duration_hours INTEGER,
    p_user_count     INTEGER,
    p_advance        BOOLEAN,
    p_food_items     JSON,
    p_food_total     NUMERIC,
    p_coupon_code    TEXT,
    p_extra_controllers INTEGER DEFAULT 0
) RETURNS bookings AS $$
DECLARE
    v_is_reservation BOOLEAN := p_start_time IS NULL;
    v_station        stations%ROWTYPE;
    v_assign_id      UUID;
    v_base           NUMERIC(10,2);
    v_discount       NUMERIC(10,2) := 0;
    v_total          NUMERIC(10,2);
    v_advance        NUMERIC(10,2) := 0;
    v_coupon         coupons%ROWTYPE;
    v_row            bookings;
    v_ctrl           NUMERIC(10,2) := 0;
BEGIN
    IF COALESCE(p_extra_controllers, 0) < 0 OR COALESCE(p_extra_controllers, 0) > 10 THEN RAISE EXCEPTION 'INVALID_CONTROLLERS'; END IF;
    IF p_duration_hours IS NULL OR p_duration_hours < 1 OR p_duration_hours > 24 THEN
        RAISE EXCEPTION 'INVALID_DURATION';
    END IF;
    IF p_user_count IS NULL OR p_user_count < 1 THEN
        RAISE EXCEPTION 'INVALID_USER_COUNT';
    END IF;
    IF COALESCE(p_food_total, 0) < 0 THEN
        RAISE EXCEPTION 'INVALID_FOOD_TOTAL';
    END IF;

    IF p_station_id IS NOT NULL THEN
        SELECT * INTO v_station FROM stations WHERE id = p_station_id AND active = true;
        IF NOT FOUND THEN RAISE EXCEPTION 'STATION_NOT_FOUND'; END IF;
        v_assign_id := v_station.id;
        IF NOT v_is_reservation THEN
            PERFORM pg_advisory_xact_lock(hashtext(v_station.id::text || left(p_start_at, 10)));
            IF EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.station_id = v_station.id AND b.status <> 'CANCELLED'
                  AND b.start_time IS NOT NULL
                  AND b.start_at < p_end_at AND b.end_at > p_start_at
            ) THEN
                RAISE EXCEPTION 'SLOT_TAKEN';
            END IF;
        END IF;
    ELSIF p_station_type IS NOT NULL THEN
        IF v_is_reservation THEN
            -- rate comes from the first active station of the type; no station is assigned yet
            SELECT * INTO v_station FROM stations WHERE type = p_station_type AND active = true ORDER BY name LIMIT 1;
            IF NOT FOUND THEN RAISE EXCEPTION 'NO_STATIONS_OF_TYPE'; END IF;
            v_assign_id := NULL;
        ELSE
            -- serialise concurrent bookings for this type/day, then pick the least-busy free station
            PERFORM pg_advisory_xact_lock(hashtext(p_station_type || left(p_start_at, 10)));
            SELECT s.* INTO v_station
            FROM stations s
            WHERE s.type = p_station_type AND s.active = true
              AND NOT EXISTS (
                  SELECT 1 FROM bookings b
                  WHERE b.station_id = s.id AND b.status <> 'CANCELLED'
                    AND b.start_time IS NOT NULL
                    AND b.start_at < p_end_at AND b.end_at > p_start_at)
            ORDER BY (SELECT count(*) FROM bookings b2
                      WHERE b2.station_id = s.id AND b2.status <> 'CANCELLED'
                        AND left(b2.start_at, 10) = left(p_start_at, 10)), s.name
            LIMIT 1;
            IF NOT FOUND THEN
                IF NOT EXISTS (SELECT 1 FROM stations WHERE type = p_station_type AND active = true) THEN
                    RAISE EXCEPTION 'NO_STATIONS_OF_TYPE';
                END IF;
                RAISE EXCEPTION 'SLOT_TAKEN';
            END IF;
            v_assign_id := v_station.id;
        END IF;
    ELSIF v_is_reservation THEN
        SELECT * INTO v_station FROM stations WHERE active = true ORDER BY name LIMIT 1;
        IF NOT FOUND THEN RAISE EXCEPTION 'NO_STATIONS_OF_TYPE'; END IF;
        v_assign_id := NULL;
    ELSE
        RAISE EXCEPTION 'STATION_REQUIRED';
    END IF;

    v_ctrl := round(COALESCE(p_extra_controllers, 0) * COALESCE(v_station.extra_controller_rate, 0) * p_duration_hours, 2);
    v_base := round(v_station.hourly_rate * p_duration_hours * p_user_count + v_ctrl + COALESCE(p_food_total, 0), 2);

    IF p_coupon_code IS NOT NULL AND p_coupon_code <> '' THEN
        SELECT * INTO v_coupon FROM coupons
        WHERE code = p_coupon_code AND is_active = true AND used_by IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND (created_for IS NULL OR created_for = p_user_id)
        FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_COUPON'; END IF;
        v_discount := round(v_base * v_coupon.discount_percentage / 100, 2);
        UPDATE coupons SET used_by = p_user_id, used_at = now() WHERE id = v_coupon.id;
    END IF;

    v_total := greatest(0, v_base - v_discount);
    -- Advance is only *expected* here; staff records the payment (amount_paid / advance_paid).
    IF p_advance THEN v_advance := round(v_total * 0.3, 2); END IF;

    INSERT INTO bookings (
        user_id, station_id, start_at, end_at, start_time, end_time, duration_hours, user_count,
        total_amount, original_amount, advance_amount, advance_paid, remaining_amount, amount_paid,
        payment_status, food_items, food_total, status, coupon_code, coupon_discount,
        extra_controllers, controller_charge
    ) VALUES (
        p_user_id, v_assign_id, p_start_at, p_end_at,
        p_start_time::time, p_end_time::time, p_duration_hours, p_user_count,
        v_total, v_base, v_advance, false, v_total, 0,
        'PENDING', COALESCE(p_food_items, '[]'::json), COALESCE(p_food_total, 0),
        CASE WHEN v_is_reservation THEN 'PENDING' ELSE 'UPCOMING' END,
        CASE WHEN v_discount > 0 THEN p_coupon_code END, v_discount,
        COALESCE(p_extra_controllers, 0), v_ctrl
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION walkin_checkin(
    p_station_id     UUID,
    p_user_id        UUID,
    p_guest_name     TEXT,
    p_guest_phone    TEXT,
    p_duration_hours INTEGER,
    p_user_count     INTEGER,
    p_now_ist        TEXT,
    p_payment_method TEXT,
    p_notes          TEXT,
    p_extra_controllers INTEGER DEFAULT 0
) RETURNS bookings AS $$
DECLARE
    s       stations%ROWTYPE;
    v_card  user_prepaid_cards%ROWTYPE;
    v_start TIMESTAMP := p_now_ist::timestamp;
    v_end   TIMESTAMP;
    v_total NUMERIC(10,2);
    v_row   bookings;
    v_ctrl  NUMERIC(10,2);
BEGIN
    IF COALESCE(p_extra_controllers, 0) < 0 OR COALESCE(p_extra_controllers, 0) > 10 THEN RAISE EXCEPTION 'INVALID_CONTROLLERS'; END IF;
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

    v_ctrl  := round(COALESCE(p_extra_controllers, 0) * COALESCE(s.extra_controller_rate, 0) * p_duration_hours, 2);
    v_total := round(s.hourly_rate * p_duration_hours * p_user_count + v_ctrl, 2);

    IF p_user_id IS NOT NULL THEN
        SELECT * INTO v_card FROM user_prepaid_cards
        WHERE user_id = p_user_id AND status = 'ACTIVE' AND remaining_minutes > 0
        ORDER BY created_at LIMIT 1;
    END IF;

    INSERT INTO bookings (
        user_id, guest_name, guest_phone, walk_in, station_id,
        start_at, end_at, start_time, end_time, duration_hours, user_count,
        total_amount, original_amount, remaining_amount, amount_paid, payment_status, paid,
        payment_method, booking_notes, status, checked_in, checked_in_at, billing_type, prepaid_card_id,
        extra_controllers, controller_charge
    ) VALUES (
        p_user_id, NULLIF(btrim(p_guest_name), ''), NULLIF(btrim(p_guest_phone), ''), true, p_station_id,
        to_char(v_start, 'YYYY-MM-DD HH24:MI:SS'), to_char(v_end, 'YYYY-MM-DD HH24:MI:SS'), v_start::time, v_end::time,
        p_duration_hours, p_user_count,
        v_total, v_total, v_total, 0, 'PENDING', false,
        NULLIF(btrim(p_payment_method), ''), NULLIF(btrim(p_notes), ''), 'ONGOING', true, now(),
        CASE WHEN v_card.id IS NOT NULL THEN 'PREPAID' ELSE 'POSTPAID' END, v_card.id,
        COALESCE(p_extra_controllers, 0), v_ctrl
    ) RETURNING * INTO v_row;

    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION stop_timer(p_booking_id UUID)
RETURNS bookings AS $$
DECLARE
    b          bookings%ROWTYPE;
    c          user_prepaid_cards%ROWTYPE;
    v_elapsed  INTEGER;
    v_first    BOOLEAN;
    v_min      INTEGER;
    v_covered  INTEGER;
    v_over_min INTEGER;
    v_over_hrs INTEGER;
    v_rate     NUMERIC;
    v_charge   NUMERIC(10,2) := 0;
    v_total    NUMERIC(10,2);
    v_row      bookings;
BEGIN
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOOKING_NOT_FOUND'; END IF;
    IF b.timer_started_at IS NULL THEN RAISE EXCEPTION 'TIMER_NOT_RUNNING'; END IF;

    v_elapsed := greatest(0, floor(extract(epoch FROM (now() - b.timer_started_at)))::int);
    v_first   := COALESCE(b.timer_total_seconds, 0) = 0;

    UPDATE bookings
    SET timer_total_seconds = COALESCE(timer_total_seconds, 0) + v_elapsed, timer_started_at = NULL
    WHERE id = b.id;

    IF b.billing_type IN ('PREPAID', 'PARTIAL_PREPAID') AND b.prepaid_card_id IS NOT NULL THEN
        SELECT * INTO c FROM user_prepaid_cards WHERE id = b.prepaid_card_id FOR UPDATE;
        IF FOUND THEN
            v_min      := greatest(1, v_elapsed / 60);
            v_covered  := least(v_min, greatest(0, c.remaining_minutes));
            v_over_min := v_min - v_covered;
            v_over_hrs := ceil(v_over_min / 60.0)::int;

            SELECT COALESCE(b.custom_hourly_rate, s.hourly_rate, 120) INTO v_rate
            FROM (SELECT 1) x LEFT JOIN stations s ON s.id = b.station_id;
            v_charge := round(v_rate * v_over_hrs * COALESCE(b.user_count, 1), 2);

            UPDATE user_prepaid_cards
            SET remaining_minutes = remaining_minutes - v_covered, updated_at = now()
            WHERE id = c.id;

            -- first stop replaces the pre-set full price; later stops add to the prepaid-adjusted total
            v_total := CASE WHEN v_first THEN COALESCE(b.controller_charge, 0) ELSE COALESCE(b.total_amount, 0) END + v_charge;

            UPDATE bookings SET
                prepaid_minutes_used = COALESCE(prepaid_minutes_used, 0) + v_covered,
                total_amount         = v_total,
                remaining_amount     = greatest(0, v_total - COALESCE(amount_paid, 0)),
                billing_type         = CASE WHEN v_total > 0 THEN 'PARTIAL_PREPAID' ELSE 'PREPAID' END,
                payment_status       = CASE
                    WHEN v_total = 0 THEN 'PREPAID'
                    WHEN COALESCE(amount_paid, 0) >= v_total THEN 'PAID'
                    WHEN COALESCE(amount_paid, 0) > 0 THEN 'PARTIAL'
                    ELSE 'PENDING' END,
                paid                 = (greatest(0, v_total - COALESCE(amount_paid, 0)) = 0)
            WHERE id = b.id;
        END IF;
    END IF;

    UPDATE user_profiles
    SET total_playtime_seconds = COALESCE(total_playtime_seconds, 0) + v_elapsed
    WHERE user_id = b.user_id;

    SELECT * INTO v_row FROM bookings WHERE id = b.id;
    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- extend_booking_hour: +1 hour (players and extra controllers are charged for the new hour too)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION extend_booking_hour(p_booking_id UUID)
RETURNS JSON AS $$
DECLARE
    b         bookings%ROWTYPE;
    v_rate    NUMERIC;
    v_crate   NUMERIC;
    v_add     NUMERIC(10,2);
    v_cadd    NUMERIC(10,2);
    v_total   NUMERIC(10,2);
    v_rem     NUMERIC(10,2);
    v_new_end TIMESTAMP;
BEGIN
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOOKING_NOT_FOUND'; END IF;
    IF b.status IN ('CANCELLED', 'ENDED') THEN RAISE EXCEPTION 'NOT_EXTENDABLE'; END IF;

    SELECT COALESCE(b.custom_hourly_rate, s.hourly_rate), COALESCE(s.extra_controller_rate, 0) INTO v_rate, v_crate
    FROM (SELECT 1) x LEFT JOIN stations s ON s.id = b.station_id;
    IF v_rate IS NULL THEN RAISE EXCEPTION 'STATION_REQUIRED'; END IF;

    v_cadd  := round(COALESCE(b.extra_controllers, 0) * v_crate, 2);
    v_add   := round(v_rate * COALESCE(b.user_count, 1), 2) + v_cadd;
    v_total := COALESCE(b.total_amount, 0) + v_add;
    v_rem   := greatest(0, v_total - COALESCE(b.amount_paid, 0));
    v_new_end := b.end_at::timestamp + interval '1 hour';

    UPDATE bookings SET
        duration_hours        = COALESCE(duration_hours, 1) + 1,
        total_amount          = v_total,
        original_amount       = COALESCE(original_amount, 0) + v_add,
        controller_charge     = COALESCE(controller_charge, 0) + v_cadd,
        remaining_amount      = v_rem,
        end_at                = to_char(v_new_end, 'YYYY-MM-DD HH24:MI:SS'),
        end_time              = CASE WHEN start_time IS NULL THEN NULL ELSE v_new_end::time END,
        paid                  = (v_rem = 0),
        payment_status        = CASE WHEN v_rem = 0 THEN 'PAID'
                                     WHEN COALESCE(amount_paid, 0) > 0 THEN 'PARTIAL'
                                     ELSE 'PENDING' END,
        grace_time_started_at = NULL,
        auto_extended_hours   = COALESCE(auto_extended_hours, 0) + 1
    WHERE id = b.id;

    RETURN json_build_object('message', 'Booking extended by 1 hour', 'new_total', v_total);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- set_extra_controllers: change the number on a booking that has not ended; the total moves by the difference
--   BOOKING_NOT_FOUND / NOT_EDITABLE (cancelled or ended) / INVALID_CONTROLLERS / CONTROLLERS_NOT_OFFERED
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_extra_controllers(p_booking_id UUID, p_count INTEGER)
RETURNS bookings AS $$
DECLARE
    b       bookings%ROWTYPE;
    v_crate NUMERIC;
    v_new   NUMERIC(10,2);
    v_diff  NUMERIC(10,2);
    v_total NUMERIC(10,2);
    v_rem   NUMERIC(10,2);
    v_row   bookings;
BEGIN
    IF p_count IS NULL OR p_count < 0 OR p_count > 10 THEN RAISE EXCEPTION 'INVALID_CONTROLLERS'; END IF;
    SELECT * INTO b FROM bookings WHERE id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'BOOKING_NOT_FOUND'; END IF;
    IF b.status IN ('CANCELLED', 'ENDED') THEN RAISE EXCEPTION 'NOT_EDITABLE'; END IF;

    SELECT COALESCE(s.extra_controller_rate, 0) INTO v_crate
    FROM (SELECT 1) x LEFT JOIN stations s ON s.id = b.station_id;
    IF p_count > COALESCE(b.extra_controllers, 0) AND COALESCE(v_crate, 0) <= 0 THEN RAISE EXCEPTION 'CONTROLLERS_NOT_OFFERED'; END IF;

    -- the rate that applied when they were added is kept for the controllers already on the booking
    v_new   := round(p_count * COALESCE(v_crate, 0) * COALESCE(b.duration_hours, 1), 2);
    v_diff  := v_new - COALESCE(b.controller_charge, 0);
    v_total := greatest(0, COALESCE(b.total_amount, 0) + v_diff);
    v_rem   := greatest(0, v_total - COALESCE(b.amount_paid, 0));

    UPDATE bookings SET
        extra_controllers = p_count,
        controller_charge = v_new,
        total_amount      = v_total,
        original_amount   = greatest(0, COALESCE(original_amount, 0) + v_diff),
        remaining_amount  = v_rem,
        paid              = (v_rem = 0),
        payment_status    = CASE WHEN v_rem = 0 THEN 'PAID'
                                 WHEN COALESCE(amount_paid, 0) > 0 THEN 'PARTIAL'
                                 ELSE 'PENDING' END
    WHERE id = b.id
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
    fn TEXT;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'create_booking(uuid,uuid,text,text,text,text,text,integer,integer,boolean,json,numeric,text,integer)',
        'walkin_checkin(uuid,uuid,text,text,integer,integer,text,text,text,integer)',
        'extend_booking_hour(uuid)',
        'set_extra_controllers(uuid,integer)',
        'stop_timer(uuid)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn); END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn); END IF;
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn); END IF;
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';
