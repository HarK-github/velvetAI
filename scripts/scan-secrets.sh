#!/usr/bin/env bash
set -euo pipefail
# Scans tracked files in the working tree (not history) for likely secrets.
PATTERNS='AIza[0-9A-Za-z_-]{30,}|AQ\.[A-Za-z0-9_-]{30,}|-----BEGIN (EC |RSA )?PRIVATE KEY|client_secret"?\s*[:=]\s*"?[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}'
if git ls-files -z | xargs -0 rg -n --no-heading -e "$PATTERNS" -- 2>/dev/null; then
  echo "Possible secret found. Remove it before committing." >&2
  exit 1
fi
echo "No secrets found in tracked files."
