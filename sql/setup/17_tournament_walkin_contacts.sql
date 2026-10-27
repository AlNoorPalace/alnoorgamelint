-- Noor Gaming Lab DB setup - players registered by staff on their behalf
-- Idempotent. Run after 12_tournament_noshow.sql and 13_whatsapp.sql.
--
-- A player staff register by hand has no account, so their phone and email live on the entry itself.
-- whatsapp_opt_in = false means staff chose not to message that player.

ALTER TABLE tournament_entrants ADD COLUMN IF NOT EXISTS phone  TEXT;
ALTER TABLE tournament_entrants ADD COLUMN IF NOT EXISTS email  TEXT;
ALTER TABLE tournament_entrants ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN NOT NULL DEFAULT true;

-- the same phone number or email is entered once per tournament (a withdrawn entry does not block it)
CREATE UNIQUE INDEX IF NOT EXISTS tournament_entrants_phone_uniq
    ON tournament_entrants (tournament_id, phone) WHERE phone IS NOT NULL AND status <> 'withdrawn';
CREATE UNIQUE INDEX IF NOT EXISTS tournament_entrants_email_uniq
    ON tournament_entrants (tournament_id, lower(email)) WHERE email IS NOT NULL AND status <> 'withdrawn';

-- staff screens: the entry's own contact first, else the member's account (a team's contact is its captain)
CREATE OR REPLACE FUNCTION tournament_contacts(p_tournament_id UUID)
RETURNS TABLE (entrant_id UUID, email TEXT, phone TEXT) AS $$
    SELECT e.id,
           COALESCE(e.email, u.email::text),
           COALESCE(e.phone, p.phone::text)
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

NOTIFY pgrst, 'reload schema';
