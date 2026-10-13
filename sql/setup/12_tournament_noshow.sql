-- Noor Gaming Lab DB setup - tournament no-shows and entrant contact details
-- Idempotent. Run after 08_tournaments.sql.

ALTER TABLE tournament_entrants ADD COLUMN IF NOT EXISTS no_show BOOLEAN NOT NULL DEFAULT false;

-- Staff need to reach players who have not turned up. Emails live in auth.users (the browser cannot read them), so the
-- API asks this server-only function. A team's contact is its captain's; walk-ins added by name have none.
CREATE OR REPLACE FUNCTION tournament_contacts(p_tournament_id UUID)
RETURNS TABLE (entrant_id UUID, email TEXT, phone TEXT) AS $$
    SELECT e.id,
           u.email::text,
           p.phone::text
    FROM tournament_entrants e
    LEFT JOIN tournament_teams t ON t.id = e.team_id
    LEFT JOIN auth.users u ON u.id = COALESCE(e.user_id, t.captain_id)
    LEFT JOIN user_profiles p ON p.user_id = COALESCE(e.user_id, t.captain_id)
    WHERE e.tournament_id = p_tournament_id;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth;

DO $$
BEGIN
    REVOKE ALL ON FUNCTION tournament_contacts(uuid) FROM PUBLIC;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON FUNCTION tournament_contacts(uuid) FROM anon; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON FUNCTION tournament_contacts(uuid) FROM authenticated; END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN GRANT EXECUTE ON FUNCTION tournament_contacts(uuid) TO service_role; END IF;
END $$;

-- the overview view was created with t.* ; the no_show column is on entrants, so nothing to rebuild there
NOTIFY pgrst, 'reload schema';
