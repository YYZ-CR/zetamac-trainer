-- Minimal Supabase shim so supabase/*.sql runs unmodified against stock Postgres.
-- Reproduces exactly the surface those files depend on: the auth schema, the
-- auth.uid() session-scoped identity, auth.users, and the two API roles.

CREATE SCHEMA IF NOT EXISTS auth;

-- raw_user_meta_data is where GoTrue stores signUp's options.data, and it is
-- the column signup.sql's trigger reads. Nullable and defaulting to nothing,
-- as it is in a real project: an account registered without it is the case
-- that trigger has to survive.
CREATE TABLE IF NOT EXISTS auth.users (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email              TEXT,
  raw_user_meta_data JSONB
);

-- For a database created by an older copy of this shim.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data JSONB;

-- Supabase derives auth.uid() from the request JWT. Here it reads a GUC so a
-- test can impersonate any user with:  SET LOCAL request.jwt.claim.sub = '<uuid>';
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', TRUE), '')::UUID;
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT USAGE ON SCHEMA auth   TO anon, authenticated;
