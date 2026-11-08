-- scripts/render-db-bootstrap.sql
-- One-time bootstrap script for Render PostgreSQL (run by database owner).
-- Run via psql using Render's External Connection string:
--   psql "<EXTERNAL_CONNECTION_STRING>" -v runtime_password="<STRONG_PASSWORD>" -f scripts/render-db-bootstrap.sql
--
-- Security: password is passed via psql variable runtime_password and never committed.

\echo '--- [1/3] Enabling btree_gist extension ---'
CREATE EXTENSION IF NOT EXISTS btree_gist;

\echo '--- [2/3] Configuring restricted runtime role velvet_runtime ---'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
    CREATE ROLE velvet_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE velvet_runtime WITH LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Schema and default table/sequence permissions (matching local migrations)
GRANT USAGE ON SCHEMA public TO velvet_runtime;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO velvet_runtime;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO velvet_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO velvet_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO velvet_runtime;

\echo '--- [3/3] Running verification introspection ---'
SELECT version();
SELECT extname FROM pg_extension WHERE extname = 'btree_gist';
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN (current_user, 'velvet_runtime');
SELECT count(*) AS total_force_rls_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
