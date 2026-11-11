-- scripts/neon-db-bootstrap.sql
-- One-time bootstrap script for Neon PostgreSQL (run by database owner, e.g. neondb_owner).
-- IMPORTANT: Run using Neon's DIRECT (unpooled, without "-pooler") connection string via psql:
--   read -s "NEON_DIRECT_URL?Neon direct owner URL: "
--   echo ""
--   read -s "RUNTIME_PASS?Enter strong password for velvet_runtime: "
--   echo ""
--   psql "$NEON_DIRECT_URL" -v runtime_password="$RUNTIME_PASS" -f scripts/neon-db-bootstrap.sql
--   unset NEON_DIRECT_URL RUNTIME_PASS
--
-- Security notes:
-- - Create velvet_runtime via SQL here rather than the Neon Console UI: roles created through the
--   Neon Console inherit neon_superuser (which grants BYPASSRLS). SQL-created roles do NOT inherit
--   neon_superuser, enforcing NOBYPASSRLS strictly.
-- - Do not commit runtime passwords or connection strings.

\echo '--- [1/3] Enabling btree_gist extension ---'
CREATE EXTENSION IF NOT EXISTS btree_gist;

\echo '--- [2/3] Configuring restricted runtime role velvet_runtime (NOBYPASSRLS) ---'
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'velvet_runtime') THEN
    CREATE ROLE velvet_runtime LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    ALTER ROLE velvet_runtime WITH LOGIN PASSWORD :'runtime_password' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Revoke any accidental neon_superuser membership if previously granted
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'neon_superuser') THEN
    REVOKE neon_superuser FROM velvet_runtime;
  END IF;
END
$$;

-- Schema and default table/sequence privileges for future tables created by neondb_owner migrations
GRANT USAGE ON SCHEMA public TO velvet_runtime;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO velvet_runtime;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO velvet_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO velvet_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO velvet_runtime;

\echo '--- [3/3] Running Neon security & extension introspection ---'
SELECT version();
SELECT extname FROM pg_extension WHERE extname = 'btree_gist';
SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname IN (current_user, 'velvet_runtime');
SELECT
  r.rolname AS role,
  ARRAY_REMOVE(ARRAY_AGG(g.rolname), NULL) AS member_of_groups
FROM pg_roles r
LEFT JOIN pg_auth_members m ON m.member = r.oid
LEFT JOIN pg_roles g ON g.oid = m.roleid
WHERE r.rolname = 'velvet_runtime'
GROUP BY r.rolname;
SELECT count(*) AS total_force_rls_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity;
