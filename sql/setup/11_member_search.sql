-- Noor Gaming Lab DB setup - member search for staff (by username, name, email or phone)
-- Idempotent. Run after 01_tables.sql. Used by the walk-in check-in screen.
--
-- Emails live in auth.users, which the browser cannot read, so the API asks this function (server only).

CREATE OR REPLACE FUNCTION search_members(p_query TEXT, p_limit INTEGER DEFAULT 8)
RETURNS TABLE (user_id UUID, username TEXT, full_name TEXT, phone TEXT, email TEXT) AS $$
    WITH q AS (
        SELECT btrim(COALESCE(p_query, '')) AS raw,
               replace(replace(replace(btrim(COALESCE(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') AS pat
    )
    SELECT p.user_id, p.username, p.full_name, p.phone::text, u.email::text
    FROM user_profiles p
    JOIN auth.users u ON u.id = p.user_id, q
    WHERE length(q.raw) >= 2
      AND (p.username ILIKE '%' || q.pat || '%'
        OR p.full_name ILIKE '%' || q.pat || '%'
        OR u.email ILIKE '%' || q.pat || '%'
        OR p.phone ILIKE '%' || q.pat || '%')
    ORDER BY (lower(p.username) = lower(q.raw) OR lower(u.email) = lower(q.raw)) DESC,
             (p.username ILIKE q.pat || '%' OR u.email ILIKE q.pat || '%') DESC,
             p.username
    LIMIT greatest(1, least(COALESCE(p_limit, 8), 20));
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth;

DO $$
BEGIN
    REVOKE ALL ON FUNCTION search_members(text, integer) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON FUNCTION search_members(text, integer) FROM anon; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON FUNCTION search_members(text, integer) FROM authenticated; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN GRANT EXECUTE ON FUNCTION search_members(text, integer) TO service_role; END IF;
END $$;

NOTIFY pgrst, 'reload schema';
